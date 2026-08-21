/**
 * Minimal MP4 (.m4a) muxer for a single AAC-LC audio track.
 *
 * WebCodecs hands back bare access units. ADTS could frame them in seven bytes,
 * but a raw .aac file is a niche intermediate format - QuickTime, Music and most
 * "open with" flows expect MP4. This writes the container people can actually
 * double-click, and it is the only container of the two that can carry a title.
 *
 * Layout is `ftyp | mdat | moov`, with `moov` last. Putting it first would mean
 * knowing every frame's size before writing a byte of audio, which is exactly
 * what a streaming export cannot do. Players open moov-at-end local files
 * without complaint; only progressive network playback needs it up front.
 *
 * One chunk holds every sample, which collapses `stsc` and `stco` to a single
 * entry each and leaves `stsz` as the only table that grows with the read.
 */

const AAC_LC_OBJECT_TYPE = 2;
const DEFAULT_FRAME_SAMPLES = 1024;

// ISO/IEC 14496-3 Table 1.16, same table ADTS indexes into.
const SAMPLE_RATE_INDEX = new Map([
  [96000, 0],
  [88200, 1],
  [64000, 2],
  [48000, 3],
  [44100, 4],
  [32000, 5],
  [24000, 6],
  [22050, 7],
  [16000, 8],
  [12000, 9],
  [11025, 10],
  [8000, 11],
  [7350, 12],
]);

const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u8 = (...values) => Uint8Array.from(values);

function u16(value) {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function ascii(text) {
  return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);
}

/**
 * A run of big-endian 32-bit values as one allocation.
 *
 * The sample tables carry one entry per AAC frame - roughly 47 a second - so
 * they must never be built by spreading an argument per entry. A 25-minute read
 * already passes the 65,536-argument ceiling every JS engine enforces, and the
 * `RangeError` would land only after the whole export had been rendered.
 */
function u32Array(count, valueAt) {
  const out = new Uint8Array(count * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) view.setUint32(i * 4, valueAt(i));
  return out;
}

/** A plain box: 32-bit size, four-character type, payload. */
function box(type, ...payload) {
  const body = concat(payload);
  return concat([u32(body.length + 8), ascii(type), body]);
}

/** A box carrying the extra version and flags byte-quartet. */
function fullBox(type, version, flags, ...payload) {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...payload);
}

/**
 * MPEG-4 descriptor framing, whose length field is base-128 with a
 * continuation bit rather than a plain integer.
 */
function descriptor(tag, ...payload) {
  const body = concat(payload);
  const lengthBytes = [];
  let remaining = body.length;
  do {
    lengthBytes.unshift(remaining & 0x7f);
    remaining >>>= 7;
  } while (remaining > 0);
  for (let i = 0; i < lengthBytes.length - 1; i++) lengthBytes[i] |= 0x80;

  return concat([u8(tag), Uint8Array.from(lengthBytes), body]);
}

/**
 * The AudioSpecificConfig an MP4 decoder needs, built by hand.
 *
 * Only used when the platform encoder does not supply its own
 * `decoderConfig.description`; its version is authoritative because it also
 * describes any tool-specific choices the encoder made.
 */
export function buildAudioSpecificConfig({ sampleRate, channels }) {
  const rateIndex = SAMPLE_RATE_INDEX.get(sampleRate);
  if (rateIndex === undefined) {
    throw new Error(`No AAC sample-rate index for ${sampleRate} Hz.`);
  }
  // 5 bits object type, 4 bits rate index, 4 bits channel config, 3 bits of
  // GASpecificConfig left at zero.
  const bits = (AAC_LC_OBJECT_TYPE << 11) | (rateIndex << 7) | ((channels & 0x0f) << 3);
  return u16(bits);
}

/** iTunes-style metadata, the reason a listener sees a title instead of a filename. */
function metadataBox({ title, artist }) {
  const entries = [
    ['\xa9nam', title],
    ['\xa9ART', artist],
    ['\xa9alb', title],
  ].filter(([, value]) => Boolean(value));
  if (entries.length === 0) return new Uint8Array(0);

  const items = entries.map(([type, value]) =>
    box(type, box('data', u32(1), u32(0), new TextEncoder().encode(String(value)))),
  );

  return box(
    'udta',
    fullBox(
      'meta',
      0,
      0,
      box('hdlr', u32(0), u32(0), ascii('mdir'), ascii('appl'), u32(0), u32(0), u8(0)),
      box('ilst', ...items),
    ),
  );
}

/**
 * Collects sample sizes and durations while the export streams, then emits the
 * index describing them.
 */
export function createMp4Muxer({ sampleRate, channels = 2, bitrate = 96000, title = '', artist = '' } = {}) {
  if (sampleRate > 0xffff) {
    // The mp4a sample-rate field is 16.16 fixed point and cannot hold more.
    throw new Error(`MP4 cannot describe a ${sampleRate} Hz audio track.`);
  }

  let sizes = new Int32Array(4096);
  let sampleCount = 0;
  let mediaDuration = 0;
  let description = null;
  // Run-length encoded so a constant frame size costs one entry, not one per frame.
  const durations = [];

  function recordDuration(samples) {
    const last = durations[durations.length - 1];
    if (last && last.delta === samples) last.count++;
    else durations.push({ count: 1, delta: samples });
    mediaDuration += samples;
  }

  return {
    get sampleCount() {
      return sampleCount;
    },
    get mediaDuration() {
      return mediaDuration;
    },
    get mimeType() {
      return 'audio/mp4';
    },
    get extension() {
      return 'm4a';
    },

    /** The encoder's own AudioSpecificConfig, preferred over a rebuilt one. */
    setDescription(bytes) {
      if (bytes?.byteLength) description = new Uint8Array(bytes);
    },

    /**
     * @param {number} byteLength size of one access unit
     * @param {number} [durationSamples] defaults to the AAC-LC frame length
     */
    addSample(byteLength, durationSamples = DEFAULT_FRAME_SAMPLES) {
      if (sampleCount === sizes.length) {
        const grown = new Int32Array(sizes.length * 2);
        grown.set(sizes);
        sizes = grown;
      }
      sizes[sampleCount++] = byteLength;
      recordDuration(Math.max(1, Math.round(durationSamples) || DEFAULT_FRAME_SAMPLES));
    },

    ftyp() {
      return box('ftyp', ascii('M4A '), u32(512), ascii('M4A '), ascii('mp42'), ascii('isom'));
    },

    /** Placeholder header; the real size is only known once audio stops. */
    mdatHeader() {
      return concat([u32(0), ascii('mdat')]);
    },

    mdatSize() {
      let payload = 0;
      for (let i = 0; i < sampleCount; i++) payload += sizes[i];
      return payload + 8;
    },

    finalMdatHeader() {
      const size = this.mdatSize();
      if (size > 0xffffffff) {
        throw new Error('This export is too large for a 32-bit MP4 chunk.');
      }
      return concat([u32(size), ascii('mdat')]);
    },

    /**
     * The index. `mdatPayloadOffset` is where the first access unit sits in the
     * finished file, which is the single entry `stco` needs.
     */
    moov(mdatPayloadOffset) {
      const movieTimescale = 1000;
      const movieDuration = Math.round((mediaDuration / sampleRate) * movieTimescale);
      const asc = description || buildAudioSpecificConfig({ sampleRate, channels });

      const esds = fullBox(
        'esds',
        0,
        0,
        descriptor(
          0x03,
          u16(1),
          u8(0),
          descriptor(
            0x04,
            u8(0x40), // MPEG-4 audio
            u8(0x15), // audio stream
            u8(0, 0, 0), // buffer size unknown
            u32(bitrate),
            u32(bitrate),
            descriptor(0x05, asc),
          ),
          descriptor(0x06, u8(0x02)),
        ),
      );

      const mp4a = box(
        'mp4a',
        u8(0, 0, 0, 0, 0, 0),
        u16(1), // data reference index
        u16(0),
        u16(0),
        u32(0),
        u16(channels),
        u16(16), // bits per sample
        u16(0),
        u16(0),
        u32(sampleRate << 16), // 16.16 fixed point
        esds,
      );

      const stts = fullBox(
        'stts',
        0,
        0,
        u32(durations.length),
        u32Array(durations.length * 2, (i) => (i % 2 === 0 ? durations[i >> 1].count : durations[i >> 1].delta)),
      );

      const stsz = fullBox(
        'stsz',
        0,
        0,
        u32(0),
        u32(sampleCount),
        u32Array(sampleCount, (i) => sizes[i]),
      );

      const stbl = box(
        'stbl',
        fullBox('stsd', 0, 0, u32(1), mp4a),
        stts,
        // One chunk holds every sample.
        fullBox('stsc', 0, 0, u32(1), u32(1), u32(Math.max(1, sampleCount)), u32(1)),
        stsz,
        fullBox('stco', 0, 0, u32(1), u32(mdatPayloadOffset)),
      );

      const minf = box(
        'minf',
        box('smhd', u8(0, 0, 0, 0), u16(0), u16(0)),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        stbl,
      );

      const mdia = box(
        'mdia',
        fullBox('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(mediaDuration), u16(0x55c4), u16(0)),
        // A FullBox: version+flags, then pre_defined, then the handler type.
        // Omitting pre_defined shifts 'soun' into it and leaves handler_type
        // zero, which is a sound track a strict demuxer will refuse to play.
        box('hdlr', u32(0), u32(0), ascii('soun'), u32(0), u32(0), u32(0), ascii('SoundHandler\0')),
        minf,
      );

      const trak = box(
        'trak',
        fullBox(
          'tkhd',
          0,
          0x000007, // enabled, in movie, in preview
          u32(0),
          u32(0),
          u32(1), // track id
          u32(0),
          u32(movieDuration),
          u32(0),
          u32(0),
          u16(0), // layer
          u16(1), // alternate group
          u16(0x0100), // full volume
          u16(0),
          ...IDENTITY_MATRIX.map(u32),
          u32(0),
          u32(0),
        ),
        mdia,
      );

      return box(
        'moov',
        fullBox(
          'mvhd',
          0,
          0,
          u32(0),
          u32(0),
          u32(movieTimescale),
          u32(movieDuration),
          u32(0x00010000), // rate 1.0
          u16(0x0100), // volume 1.0
          u16(0),
          u32(0),
          u32(0),
          ...IDENTITY_MATRIX.map(u32),
          ...Array.from({ length: 6 }, () => u32(0)),
          u32(2), // next track id
        ),
        trak,
        metadataBox({ title, artist }),
      );
    },
  };
}

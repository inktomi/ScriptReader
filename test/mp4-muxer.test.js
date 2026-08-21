import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAudioSpecificConfig, createMp4Muxer } from '../src/audio/mp4-muxer.js';

/**
 * Walk an MP4 box tree.
 *
 * Written independently of the muxer on purpose: a test that reused the
 * muxer's own writers would agree with it about a wrong layout.
 */
function parseBoxes(bytes, start = 0, end = bytes.length) {
  const boxes = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;

  while (at + 8 <= end) {
    const size = view.getUint32(at);
    const name = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (size < 8 || at + size > end) break;
    boxes.push({ type: name, start: at, size, body: [at + 8, at + size] });
    at += size;
  }
  return boxes;
}

/**
 * Bytes a box holds before its children begin.
 *
 * `stsd` is a full box followed by an entry count; `meta` is a full box; and an
 * `mp4a` sample entry carries the whole audio description - reserved bytes,
 * channel count, sample size and the 16.16 sample rate - before `esds`.
 */
const CHILD_PREAMBLE = { stsd: 8, meta: 4, mp4a: 28 };

function findBox(bytes, path, start = 0, end = bytes.length) {
  let scope = [start, end];
  let found = null;
  for (const want of path) {
    const boxes = parseBoxes(bytes, scope[0] + (found ? CHILD_PREAMBLE[found.type] || 0 : 0), scope[1]);
    found = boxes.find((b) => b.type === want);
    if (!found) return null;
    scope = found.body;
  }
  return found;
}

// Where the 16.16 sample rate sits inside an mp4a body.
const MP4A_SAMPLE_RATE_OFFSET = 24;

function u32At(bytes, at) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
}

function fourcc(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function muxSamples(muxer, sizes, durations) {
  sizes.forEach((size, i) => {
    muxer.addSample(size, durations ? durations[i] : undefined);
  });
}

test('the AudioSpecificConfig states AAC-LC at the right rate and channel count', () => {
  // 5 bits object type (2), 4 bits rate index, 4 bits channels, 3 spare.
  assert.deepEqual([...buildAudioSpecificConfig({ sampleRate: 48000, channels: 2 })], [0x11, 0x90]);
  assert.deepEqual([...buildAudioSpecificConfig({ sampleRate: 24000, channels: 2 })], [0x13, 0x10]);
  assert.deepEqual([...buildAudioSpecificConfig({ sampleRate: 44100, channels: 1 })], [0x12, 0x08]);
  assert.throws(() => buildAudioSpecificConfig({ sampleRate: 37000, channels: 2 }), /No AAC sample-rate index/);
});

test('ftyp announces an M4A file', () => {
  const muxer = createMp4Muxer({ sampleRate: 48000 });
  const ftyp = muxer.ftyp();

  assert.equal(fourcc(ftyp, 4), 'ftyp');
  assert.equal(u32At(ftyp, 0), ftyp.length);
  assert.equal(fourcc(ftyp, 8), 'M4A ');
  const brands = [fourcc(ftyp, 16), fourcc(ftyp, 20), fourcc(ftyp, 24)];
  assert.deepEqual(brands, ['M4A ', 'mp42', 'isom']);
});

test('the mdat header is corrected to the audio it ended up holding', () => {
  const muxer = createMp4Muxer({ sampleRate: 48000 });
  const placeholder = muxer.mdatHeader();
  assert.equal(u32At(placeholder, 0), 0, 'the size is not knowable up front');
  assert.equal(fourcc(placeholder, 4), 'mdat');

  muxSamples(muxer, [400, 380, 420]);
  const corrected = muxer.finalMdatHeader();
  assert.equal(u32At(corrected, 0), 400 + 380 + 420 + 8);
  assert.equal(fourcc(corrected, 4), 'mdat');
  assert.equal(muxer.mdatSize(), 1208);
});

test('the sample table indexes every frame the encoder produced', () => {
  const muxer = createMp4Muxer({ sampleRate: 48000, channels: 2 });
  const sizes = [301, 299, 305, 300];
  muxSamples(muxer, sizes);

  const payloadOffset = muxer.ftyp().length + 8;
  const moov = muxer.moov(payloadOffset);

  const stsz = findBox(moov, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']);
  assert.ok(stsz, 'no stsz in the index');
  const [stszStart] = stsz.body;
  assert.equal(u32At(moov, stszStart + 4), 0, 'a uniform size would misdescribe these frames');
  assert.equal(u32At(moov, stszStart + 8), sizes.length);
  for (let i = 0; i < sizes.length; i++) {
    assert.equal(u32At(moov, stszStart + 12 + i * 4), sizes[i], `sample ${i}`);
  }

  // One chunk holds them all, so stco names exactly where mdat's payload starts.
  const stco = findBox(moov, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']);
  assert.equal(u32At(moov, stco.body[0] + 4), 1);
  assert.equal(u32At(moov, stco.body[0] + 8), payloadOffset);

  const stsc = findBox(moov, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsc']);
  assert.equal(u32At(moov, stsc.body[0] + 4), 1);
  assert.equal(u32At(moov, stsc.body[0] + 12), sizes.length, 'samples per chunk');
});

test('constant frame durations collapse to a single stts run', () => {
  const muxer = createMp4Muxer({ sampleRate: 48000 });
  muxSamples(muxer, [300, 300, 300, 300, 300]);

  const moov = muxer.moov(100);
  const stts = findBox(moov, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']);
  assert.equal(u32At(moov, stts.body[0] + 4), 1, 'five identical frames should be one entry');
  assert.equal(u32At(moov, stts.body[0] + 8), 5);
  assert.equal(u32At(moov, stts.body[0] + 12), 1024);
  assert.equal(muxer.mediaDuration, 5 * 1024);
});

test('a changed frame duration opens a new stts run rather than being lost', () => {
  const muxer = createMp4Muxer({ sampleRate: 48000 });
  muxSamples(muxer, [300, 300, 300], [1024, 1024, 512]);

  const moov = muxer.moov(100);
  const stts = findBox(moov, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']);
  assert.equal(u32At(moov, stts.body[0] + 4), 2);
  assert.equal(u32At(moov, stts.body[0] + 8), 2);
  assert.equal(u32At(moov, stts.body[0] + 12), 1024);
  assert.equal(u32At(moov, stts.body[0] + 16), 1);
  assert.equal(u32At(moov, stts.body[0] + 20), 512);
  assert.equal(muxer.mediaDuration, 1024 + 1024 + 512);
});

test('the track declares the sample rate the audio is actually at', () => {
  const muxer = createMp4Muxer({ sampleRate: 44100, channels: 2 });
  muxSamples(muxer, [300]);
  const moov = muxer.moov(100);

  const mdhd = findBox(moov, ['moov', 'trak', 'mdia', 'mdhd']);
  assert.equal(u32At(moov, mdhd.body[0] + 12), 44100, 'mdhd timescale');
  assert.equal(u32At(moov, mdhd.body[0] + 16), 1024, 'mdhd duration in samples');

  const mp4a = findBox(moov, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a']);
  assert.ok(mp4a, 'no mp4a sample entry');
  // 16.16 fixed point, so the rate lives in the high half.
  assert.equal(u32At(moov, mp4a.body[0] + MP4A_SAMPLE_RATE_OFFSET) >>> 16, 44100);
});

test("the encoder's own decoder config wins over a rebuilt one", () => {
  const muxer = createMp4Muxer({ sampleRate: 48000, channels: 2 });
  muxer.setDescription(Uint8Array.from([0x11, 0x91, 0x56, 0xe5, 0x00]));
  muxSamples(muxer, [300]);

  const moov = muxer.moov(100);
  const esds = findBox(moov, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a', 'esds']);
  assert.ok(esds, 'no esds inside mp4a');

  // The five description bytes must appear verbatim inside the descriptor tree.
  const body = moov.slice(esds.body[0], esds.body[1]);
  const needle = [0x11, 0x91, 0x56, 0xe5, 0x00].join(',');
  const found = [...body].some((_, i) => [...body.slice(i, i + 5)].join(',') === needle);
  assert.ok(found, 'the encoder description never reached the file');
});

test('a title reaches the metadata a player will display', () => {
  const muxer = createMp4Muxer({ sampleRate: 48000, title: 'The Neon Heist' });
  muxSamples(muxer, [300]);
  const moov = muxer.moov(100);

  const udta = findBox(moov, ['moov', 'udta']);
  assert.ok(udta, 'no metadata box');
  const text = new TextDecoder().decode(moov.slice(udta.start, udta.start + udta.size));
  assert.match(text, /The Neon Heist/);
});

test('a rate MP4 cannot describe is refused rather than silently truncated', () => {
  // The mp4a rate field is 16.16 fixed point.
  assert.throws(() => createMp4Muxer({ sampleRate: 96000 }), /cannot describe/);
});

test('the whole file parses as a well-formed box tree', () => {
  const muxer = createMp4Muxer({ sampleRate: 48000, title: 'Parse me' });
  const sizes = [310, 288, 300];
  muxSamples(muxer, sizes);

  const ftyp = muxer.ftyp();
  const payload = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  const file = new Uint8Array(ftyp.length + 8 + payload.length + muxer.moov(ftyp.length + 8).length);
  let at = 0;
  file.set(ftyp, at);
  at += ftyp.length;
  file.set(muxer.finalMdatHeader(), at);
  at += 8;
  file.set(payload, at);
  at += payload.length;
  file.set(muxer.moov(ftyp.length + 8), at);

  // Top-level boxes must tile the file exactly, with nothing left over.
  const top = parseBoxes(file);
  assert.deepEqual(
    top.map((b) => b.type),
    ['ftyp', 'mdat', 'moov'],
  );
  assert.equal(
    top.reduce((sum, b) => sum + b.size, 0),
    file.length,
    'boxes do not account for every byte',
  );
});

test('a feature-length read indexes without overflowing the argument limit', () => {
  const muxer = createMp4Muxer({ sampleRate: 48000 });
  // AAC-LC emits ~47 frames a second, so this is roughly 71 minutes - well past
  // the 65,536-argument ceiling that a spread-per-sample table would hit, and
  // it would only have thrown after the whole export had been rendered.
  const frames = 200_000;
  for (let i = 0; i < frames; i++) muxer.addSample(280 + (i % 11));

  const moov = muxer.moov(36);
  const stsz = findBox(moov, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']);
  assert.equal(u32At(moov, stsz.body[0] + 8), frames);
  // Spot-check both ends of the table rather than all 200k.
  assert.equal(u32At(moov, stsz.body[0] + 12), 280);
  assert.equal(u32At(moov, stsz.body[0] + 12 + (frames - 1) * 4), 280 + ((frames - 1) % 11));
  assert.equal(muxer.sampleCount, frames);
});

test('the sound track declares a handler type a demuxer will accept', () => {
  const muxer = createMp4Muxer({ sampleRate: 48000 });
  muxSamples(muxer, [300]);
  const moov = muxer.moov(100);

  const hdlr = findBox(moov, ['moov', 'trak', 'mdia', 'hdlr']);
  assert.ok(hdlr, 'no handler box on the media');

  // hdlr is a FullBox: version+flags, pre_defined, handler_type. Dropping
  // pre_defined slides 'soun' into it and leaves handler_type zero, which is a
  // track strict players treat as having no handler at all.
  const [start] = hdlr.body;
  assert.equal(u32At(moov, start), 0, 'version and flags');
  assert.equal(u32At(moov, start + 4), 0, 'pre_defined must be zero');
  assert.equal(fourcc(moov, start + 8), 'soun', 'handler_type');
  assert.equal(u32At(moov, start + 12), 0, 'reserved');
  assert.equal(u32At(moov, start + 16), 0, 'reserved');
  assert.equal(u32At(moov, start + 20), 0, 'reserved');
  assert.match(new TextDecoder().decode(moov.slice(start + 24, hdlr.body[1])), /^SoundHandler/);
});

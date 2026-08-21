import { createAacEncoder, DEFAULT_AAC_BITRATE, pickAacConfig } from './aac-encoder.js';
import { openExportSink } from './export-sink.js';
import { createMp4Muxer } from './mp4-muxer.js';
import { exportFilename, renderUnitOffline, runScriptExport } from './script-exporter.js';
import { createWavWriter, WAV_HEADER_BYTES } from './wav-writer.js';

/**
 * Platform wiring for an export: pick a codec, open a destination, run the
 * pipeline, correct the header.
 *
 * `script-exporter.js` holds the part worth testing - placement, mixing,
 * limiting - and knows nothing about WebCodecs, MP4, or the File System Access
 * API. This module is the seam where those meet.
 */

const EXPORT_CHANNELS = 2;
const EXPORT_ARTIST = 'ScriptReader table read';

/**
 * Choose the best codec this browser will actually encode, and the sample rate
 * the whole export therefore runs at.
 *
 * AAC is preferred for the obvious reason - a two-hour read is tens of megabytes
 * rather than a gigabyte - but Firefox ships `AudioEncoder` without an AAC
 * encoder, so WAV is a real destination here, not a token fallback.
 */
export async function chooseExportCodec({ nativeSampleRate = 24000, bitrate = DEFAULT_AAC_BITRATE } = {}) {
  const aac = await pickAacConfig({ channels: EXPORT_CHANNELS, bitrate });
  if (aac) return { kind: 'aac', config: aac, sampleRate: aac.sampleRate, bitrate };
  return { kind: 'wav', config: null, sampleRate: nativeSampleRate, bitrate };
}

/**
 * An .m4a writer: raw AAC frames into `mdat`, the index appended afterwards.
 *
 * The MP4 index cannot be written until every frame's size is known, so `mdat`
 * goes out with a placeholder length that `finalise` corrects in place. That is
 * the whole reason the sink exposes `patch`.
 */
function createMp4Target({ codec, title, sink, pendingWrites }) {
  const muxer = createMp4Muxer({
    sampleRate: codec.sampleRate,
    channels: EXPORT_CHANNELS,
    bitrate: codec.bitrate,
    title,
    artist: EXPORT_ARTIST,
  });

  const ftyp = muxer.ftyp();
  const mdatOffset = ftyp.length;
  const mdatPayloadOffset = mdatOffset + 8;

  const encoder = createAacEncoder({
    config: codec.config,
    channels: EXPORT_CHANNELS,
    onDescription: (description) => muxer.setDescription(description),
    onChunk: (bytes, durationSamples) => {
      muxer.addSample(bytes.byteLength, durationSamples);
      pendingWrites.push(bytes);
    },
  });

  return {
    encoder,
    mimeType: muxer.mimeType,
    extension: muxer.extension,
    async begin() {
      await sink.write(ftyp);
      await sink.write(muxer.mdatHeader());
    },
    async finalise() {
      await sink.write(muxer.moov(mdatPayloadOffset));
      await sink.patch(mdatOffset, muxer.finalMdatHeader());
    },
  };
}

/** The uncompressed destination, for browsers with no AAC encoder. */
function createWavTarget({ codec, sink, pendingWrites }) {
  const writer = createWavWriter({ sampleRate: codec.sampleRate, channels: EXPORT_CHANNELS });

  return {
    encoder: {
      async encode(planes) {
        pendingWrites.push(writer.encode(planes));
      },
      async finish() {},
      close() {},
    },
    mimeType: writer.mimeType,
    extension: writer.extension,
    async begin() {
      await sink.write(writer.header());
    },
    async finalise() {
      await sink.patch(0, writer.finalHeader());
    },
  };
}

/**
 * Render, encode and save one script.
 *
 * Cleanup is the delicate half. On any failure - including the listener
 * dismissing the save dialog - the sink is aborted so a partially written file
 * is emptied rather than left looking like a complete recording.
 *
 * @returns {Promise<{filename: string, seconds: number, codec: string, sampleRate: number}>}
 */
export async function runExportJob({
  clusters,
  title,
  nativeSampleRate = 24000,
  requestUnit,
  signal,
  onProgress = () => {},
  prepare = async () => {},
  OfflineContext = globalThis.OfflineAudioContext,
  openSink = openExportSink,
  chooseCodec = chooseExportCodec,
}) {
  if (!OfflineContext) {
    throw new Error('This browser cannot render audio offline, so the read cannot be exported.');
  }
  if (!clusters.length) {
    throw new Error('There is nothing in this script to export.');
  }

  const codec = await chooseCodec({ nativeSampleRate });
  const sampleRate = codec.sampleRate;
  const extension = codec.kind === 'aac' ? 'm4a' : 'wav';
  const mimeType = codec.kind === 'aac' ? 'audio/mp4' : 'audio/wav';
  const filename = exportFilename(title, extension);

  // The sink is opened before any rendering starts: the save dialog needs the
  // click that began the export to still count as a user gesture, and a listener
  // who cancels it should not have waited through a render first.
  const sink = await openSink({ filename, mimeType, extension });

  const pendingWrites = [];
  // Encoder output arrives synchronously from its own callback; this drains it
  // to the sink between windows so back-pressure is real.
  async function drain() {
    while (pendingWrites.length > 0) {
      await sink.write(pendingWrites.shift());
    }
  }

  // Built inside the try: `configure` can reject a codec the probe accepted, and
  // a throw out here would strand the writable stream this sink already holds.
  let target = null;
  try {
    // Everything slow happens after the picker has been answered. The dialog
    // needs the click that began the export to still count as a live user
    // gesture, and warming a cold voice model outlasts that window easily.
    await prepare();

    target =
      codec.kind === 'aac'
        ? createMp4Target({ codec, title, sink, pendingWrites })
        : createWavTarget({ codec, sink, pendingWrites });

    await target.begin();

    const result = await runScriptExport({
      clusters,
      sampleRate,
      encoder: {
        async encode(planes) {
          await target.encoder.encode(planes);
          await drain();
        },
        async finish() {
          await target.encoder.finish();
          await drain();
        },
      },
      // The file is closed below, once the index and header are corrected.
      sink: { close: async () => {} },
      requestUnit,
      renderUnit: (args) => renderUnitOffline({ ...args, OfflineContext }),
      signal,
      onProgress,
    });

    await target.finalise();
    await sink.close();

    return { filename, seconds: result.seconds, codec: codec.kind, sampleRate };
  } catch (err) {
    await sink.abort();
    throw err;
  } finally {
    target?.encoder.close();
  }
}

export { WAV_HEADER_BYTES };

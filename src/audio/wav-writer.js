import { encodePcm16 } from './chatterbox-render-store.js';

/**
 * Streaming WAV writer for the script exporter.
 *
 * The engines already have a mono WAV encoder (`float32ToWavBase64` in
 * runpod-engine.js) but it is base64-in, single-channel, and sizes its header
 * from a buffer it holds whole. An export is stereo, is written a window at a
 * time, and must not hold the finished file in memory — so the header goes out
 * first with placeholder sizes and is patched once the last frame is known.
 *
 * Float→Int16 conversion is deliberately `encodePcm16` from the render store
 * rather than a second local copy: one rounding convention across everything
 * this app writes to disk or to IndexedDB.
 */

export const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/**
 * A 44-byte canonical RIFF/PCM header. `dataBytes` may be zero when the header
 * is written ahead of the audio; call again with the real count and rewrite the
 * first 44 bytes.
 */
export function buildWavHeader({ sampleRate, channels = 2, dataBytes = 0 }) {
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(buffer);

  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataBytes, true);

  return new Uint8Array(buffer);
}

/**
 * Interleave planar float channels into one Int16 frame stream.
 *
 * Channels shorter than the longest are read as silence past their end rather
 * than truncating the frame count, so a mixer flush that produced an uneven
 * pair cannot silently shorten the file.
 */
export function interleavePcm16(channels) {
  const planes = channels.map((plane) => encodePcm16(plane));
  const frames = planes.reduce((max, plane) => Math.max(max, plane.length), 0);
  const out = new Int16Array(frames * planes.length);

  for (let frame = 0; frame < frames; frame++) {
    const base = frame * planes.length;
    for (let channel = 0; channel < planes.length; channel++) {
      const plane = planes[channel];
      out[base + channel] = frame < plane.length ? plane[frame] : 0;
    }
  }

  return out;
}

/**
 * Turns planar float windows into WAV bytes, tracking how many data bytes have
 * gone out so the header can be corrected at the end.
 *
 * The caller owns delivery — a file handle or an array of Blob parts — because
 * only it knows whether rewriting byte 0 is possible.
 */
export function createWavWriter({ sampleRate, channels = 2 }) {
  let dataBytes = 0;

  return {
    get dataBytes() {
      return dataBytes;
    },
    get mimeType() {
      return 'audio/wav';
    },
    get extension() {
      return 'wav';
    },
    header() {
      return buildWavHeader({ sampleRate, channels, dataBytes: 0 });
    },
    /** @returns {Uint8Array} the bytes for this window. */
    encode(planes) {
      const pcm = interleavePcm16(planes);
      dataBytes += pcm.byteLength;
      return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    },
    /** The corrected header, once every window has been encoded. */
    finalHeader() {
      return buildWavHeader({ sampleRate, channels, dataBytes });
    },
  };
}

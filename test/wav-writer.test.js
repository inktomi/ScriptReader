import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWavHeader, createWavWriter, interleavePcm16, WAV_HEADER_BYTES } from '../src/audio/wav-writer.js';

function readHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    riff: view.getUint32(0, false),
    riffSize: view.getUint32(4, true),
    wave: view.getUint32(8, false),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataSize: view.getUint32(40, true),
  };
}

test('the header states a canonical stereo PCM stream', () => {
  const header = buildWavHeader({ sampleRate: 24000, channels: 2, dataBytes: 960 });
  assert.equal(header.byteLength, WAV_HEADER_BYTES);

  const parsed = readHeader(header);
  assert.equal(parsed.riff, 0x52494646);
  assert.equal(parsed.wave, 0x57415645);
  assert.equal(parsed.fmtSize, 16);
  assert.equal(parsed.format, 1);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.blockAlign, 4);
  assert.equal(parsed.byteRate, 24000 * 4);
  assert.equal(parsed.dataSize, 960);
  assert.equal(parsed.riffSize, 36 + 960);
});

test('planar channels interleave frame by frame', () => {
  const left = Float32Array.from([1, 0, -1]);
  const right = Float32Array.from([-1, 0, 1]);
  const pcm = interleavePcm16([left, right]);

  assert.equal(pcm.length, 6);
  assert.equal(pcm[0], 32767); // L full scale
  assert.equal(pcm[1], -32768); // R full scale negative
  assert.equal(pcm[2], 0);
  assert.equal(pcm[3], 0);
  assert.equal(pcm[4], -32768);
  assert.equal(pcm[5], 32767);
});

test('an uneven pair pads with silence rather than shortening the file', () => {
  const pcm = interleavePcm16([Float32Array.from([1, 1]), Float32Array.from([1])]);
  assert.equal(pcm.length, 4);
  assert.equal(pcm[3], 0);
});

test('the writer corrects its header once every window has been encoded', () => {
  const writer = createWavWriter({ sampleRate: 8000, channels: 2 });
  assert.equal(readHeader(writer.header()).dataSize, 0);

  const silence = new Float32Array(100);
  writer.encode([silence, silence]);
  writer.encode([silence, silence]);

  // 200 frames, two channels, two bytes each.
  assert.equal(writer.dataBytes, 800);
  const parsed = readHeader(writer.finalHeader());
  assert.equal(parsed.dataSize, 800);
  assert.equal(parsed.riffSize, 836);
});

test('a ramp survives the float round trip within one quantisation step', () => {
  const writer = createWavWriter({ sampleRate: 8000, channels: 2 });
  const ramp = Float32Array.from({ length: 64 }, (_, i) => -1 + (2 * i) / 63);
  const bytes = writer.encode([ramp, ramp]);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frame = 0; frame < ramp.length; frame++) {
    // The store's own inverse: negatives scale by 0x8000, positives by 0x7fff.
    const raw = view.getInt16(frame * 4, true);
    const decoded = raw < 0 ? raw / 0x8000 : raw / 0x7fff;
    assert.ok(Math.abs(decoded - ramp[frame]) < 1 / 32767 + 1e-6, `frame ${frame} drifted`);
  }
});

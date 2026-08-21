import assert from 'node:assert/strict';
import test from 'node:test';
import { runExportJob } from '../src/audio/export-job.js';

function recordingSink(log) {
  return {
    async write() {
      log.push('write');
    },
    async patch() {
      log.push('patch');
    },
    async close() {
      log.push('close');
    },
    async abort() {
      log.push('abort');
    },
  };
}

const WAV_CODEC = async () => ({ kind: 'wav', config: null, sampleRate: 24000, bitrate: 96000 });
const CLUSTERS = [[{ key: 'a', estimatedDuration: 1, playbackRate: 1, gain: 1, pan: 0, anchor: 'sequential' }]];

function OfflineContextStub() {
  return {
    createBufferSource: () => ({ connect: () => {}, start: () => {}, stop: () => {}, playbackRate: {} }),
    createGain: () => ({ connect: () => {}, gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} } }),
    createStereoPanner: () => ({ connect: () => {}, pan: { value: 0 } }),
    destination: {},
    startRendering: async () => ({ getChannelData: () => new Float32Array(8) }),
  };
}

test('the destination is opened before anything slow runs', async () => {
  const order = [];
  const sink = {
    async write() {},
    async patch() {},
    async close() {},
    async abort() {
      order.push('abort');
    },
  };

  await assert.rejects(
    () =>
      runExportJob({
        clusters: CLUSTERS,
        title: 'Ordering',
        chooseCodec: WAV_CODEC,
        OfflineContext: OfflineContextStub,
        openSink: async () => {
          order.push('openSink');
          return sink;
        },
        prepare: async () => {
          // Standing in for a cold voice model: seconds of work that would
          // outlive the click's user activation if it ran before the picker.
          order.push('prepare');
          throw new Error('Studio Local could not be started.');
        },
        requestUnit: () => Promise.resolve({ duration: 1 }),
      }),
    /Studio Local could not be started/,
  );

  assert.deepEqual(order, ['openSink', 'prepare', 'abort']);
});

test('a failure while preparing empties the file rather than leaving a stub', async () => {
  const log = [];
  await assert.rejects(
    () =>
      runExportJob({
        clusters: CLUSTERS,
        title: 'Cleanup',
        chooseCodec: WAV_CODEC,
        OfflineContext: OfflineContextStub,
        openSink: async () => recordingSink(log),
        prepare: async () => {
          throw new Error('nope');
        },
        requestUnit: () => Promise.resolve({ duration: 1 }),
      }),
    /nope/,
  );

  assert.ok(log.includes('abort'), 'the sink was never aborted');
  assert.ok(!log.includes('close'), 'a failed export must not finalise its file');
});

test('an encoder that cannot be constructed still releases the open file', async () => {
  // No WebCodecs here, so asking for AAC makes the target constructor throw -
  // after the sink has already taken a writable handle on the file.
  const log = [];
  const saved = globalThis.AudioEncoder;
  delete globalThis.AudioEncoder;

  try {
    await assert.rejects(() =>
      runExportJob({
        clusters: CLUSTERS,
        title: 'Encoder blows up',
        chooseCodec: async () => ({ kind: 'aac', config: { sampleRate: 48000 }, sampleRate: 48000, bitrate: 96000 }),
        OfflineContext: OfflineContextStub,
        openSink: async () => recordingSink(log),
        requestUnit: () => Promise.resolve({ duration: 1 }),
      }),
    );
  } finally {
    if (saved) globalThis.AudioEncoder = saved;
  }

  assert.ok(log.includes('abort'), 'the writable stream was left open');
  assert.ok(!log.includes('close'));
});

test('the extension and mime type follow the codec that was chosen', async () => {
  const result = await runExportJob({
    clusters: CLUSTERS,
    title: 'Fallback Read',
    chooseCodec: WAV_CODEC,
    OfflineContext: OfflineContextStub,
    openSink: async ({ filename, mimeType }) => {
      assert.equal(filename, 'Fallback Read.wav');
      assert.equal(mimeType, 'audio/wav');
      return recordingSink([]);
    },
    requestUnit: () => Promise.resolve({ duration: 1 }),
  });

  assert.equal(result.codec, 'wav');
  assert.equal(result.filename, 'Fallback Read.wav');
});

test('a browser with no offline rendering refuses before opening anything', async () => {
  let opened = false;
  await assert.rejects(
    () =>
      runExportJob({
        clusters: CLUSTERS,
        title: 'No Web Audio',
        OfflineContext: undefined,
        openSink: async () => {
          opened = true;
          return recordingSink([]);
        },
        requestUnit: () => Promise.resolve({ duration: 1 }),
      }),
    /cannot render audio offline/,
  );
  assert.equal(opened, false, 'prompted for a destination it could never fill');
});

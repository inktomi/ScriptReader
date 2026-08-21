import assert from 'node:assert/strict';
import test from 'node:test';
import { createAacEncoder, PREFERRED_EXPORT_RATES, pickAacConfig } from '../src/audio/aac-encoder.js';

// ------------------------------------------------------------- codec probing

test('no AudioEncoder means no AAC, and the caller falls back to WAV', async () => {
  const saved = globalThis.AudioEncoder;
  delete globalThis.AudioEncoder;
  try {
    assert.equal(await pickAacConfig(), null);
  } finally {
    if (saved) globalThis.AudioEncoder = saved;
  }
});

test('the native engine rate is preferred over resampling to a common one', async () => {
  const asked = [];
  globalThis.AudioEncoder = {
    async isConfigSupported(config) {
      asked.push(config.sampleRate);
      return { supported: true, config };
    },
  };
  try {
    const picked = await pickAacConfig();
    assert.equal(picked.sampleRate, 24000);
    assert.equal(picked.codec, 'mp4a.40.2');
    assert.equal(picked.numberOfChannels, 2);
    // Bare access units, because the MP4 sample table does the framing.
    assert.deepEqual(picked.aac, { format: 'aac' });
    assert.deepEqual(asked, [24000], 'probed further than it needed to');
  } finally {
    delete globalThis.AudioEncoder;
  }
});

test('an encoder that refuses 24 kHz is offered the next rate down the list', async () => {
  globalThis.AudioEncoder = {
    async isConfigSupported(config) {
      if (config.sampleRate === 24000) return { supported: false };
      return { supported: true, config };
    },
  };
  try {
    assert.equal((await pickAacConfig()).sampleRate, 48000);
  } finally {
    delete globalThis.AudioEncoder;
  }
});

test('an encoder that throws on a rate is treated as refusing it', async () => {
  globalThis.AudioEncoder = {
    async isConfigSupported(config) {
      if (config.sampleRate !== 44100) throw new TypeError('unsupported');
      return { supported: true, config };
    },
  };
  try {
    assert.equal((await pickAacConfig()).sampleRate, 44100);
  } finally {
    delete globalThis.AudioEncoder;
  }
});

test('an encoder that refuses every rate falls back rather than guessing', async () => {
  globalThis.AudioEncoder = {
    async isConfigSupported() {
      return { supported: false };
    },
  };
  try {
    assert.equal(await pickAacConfig(), null);
  } finally {
    delete globalThis.AudioEncoder;
  }
});

test('every preferred rate is one AAC actually defines', () => {
  assert.deepEqual(PREFERRED_EXPORT_RATES, [24000, 48000, 44100]);
});

// ------------------------------------------------------------- backpressure

/**
 * Enough of `AudioEncoder` to drive the queue.
 *
 * Deliberately does NOT fire `dequeue` when it fails: that is exactly what the
 * real API does when it closes on an error, and the reason a waiter parked on
 * that event needs waking from the error path instead.
 */
class MockAudioEncoder {
  static last = null;

  constructor({ output, error }) {
    this.output = output;
    this.errorCallback = error;
    this.encodeQueueSize = 0;
    this.listeners = new Map();
    this.closed = false;
    MockAudioEncoder.last = this;
  }
  configure() {}
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  encode() {
    // Deep enough to put `drainTo` to sleep.
    this.encodeQueueSize = 20;
  }
  dequeue() {
    this.encodeQueueSize = 0;
    for (const fn of this.listeners.get('dequeue') || []) fn();
    this.listeners.set('dequeue', []);
  }
  fail(err) {
    this.closed = true;
    this.errorCallback(err);
  }
  async flush() {}
  close() {
    this.closed = true;
  }
}

class MockAudioData {
  constructor(init) {
    Object.assign(this, init);
  }
  close() {}
}

function withMockCodecs(run) {
  const savedEncoder = globalThis.AudioEncoder;
  const savedData = globalThis.AudioData;
  globalThis.AudioEncoder = MockAudioEncoder;
  globalThis.AudioData = MockAudioData;
  try {
    return run();
  } finally {
    if (savedEncoder) globalThis.AudioEncoder = savedEncoder;
    else delete globalThis.AudioEncoder;
    if (savedData) globalThis.AudioData = savedData;
    else delete globalThis.AudioData;
  }
}

/** Fails the test rather than hanging the suite when a promise never settles. */
function withDeadline(promise, ms = 1000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('deadlocked waiting on the encoder')), ms).unref?.()),
  ]);
}

test('an encoder that fails while backpressured rejects instead of hanging', async () => {
  await withMockCodecs(async () => {
    const encoder = createAacEncoder({
      config: { sampleRate: 48000 },
      channels: 2,
      onChunk: () => {},
    });

    const planes = [new Float32Array(1024), new Float32Array(1024)];
    const pending = encoder.encode(planes);

    // The encoder dies with the queue deep. WebCodecs emits no `dequeue` here,
    // so without the error path waking the waiter this never settles.
    MockAudioEncoder.last.fail(new Error('encoder exploded'));

    await assert.rejects(() => withDeadline(pending), /encoder exploded/);
  });
});

test('a draining queue lets encoding continue', async () => {
  await withMockCodecs(async () => {
    const chunks = [];
    const encoder = createAacEncoder({
      config: { sampleRate: 48000 },
      channels: 2,
      onChunk: (bytes) => chunks.push(bytes),
    });

    const planes = [new Float32Array(1024), new Float32Array(1024)];
    const pending = encoder.encode(planes);
    MockAudioEncoder.last.dequeue();

    await withDeadline(pending);
    assert.equal(MockAudioEncoder.last.closed, false);

    encoder.close();
    assert.equal(MockAudioEncoder.last.closed, true);
  });
});

test('the encoder reports its own decoder description exactly once', async () => {
  await withMockCodecs(async () => {
    const seen = [];
    createAacEncoder({
      config: { sampleRate: 48000 },
      channels: 2,
      onChunk: () => {},
      onDescription: (bytes) => seen.push([...bytes]),
    });

    const chunk = { byteLength: 3, duration: 21333, copyTo: (out) => out.set([1, 2, 3]) };
    const meta = { decoderConfig: { description: Uint8Array.from([0x11, 0x90]).buffer } };
    MockAudioEncoder.last.output(chunk, meta);
    MockAudioEncoder.last.output(chunk, meta);

    assert.deepEqual(seen, [[0x11, 0x90]], 'the description should be reported once');
  });
});

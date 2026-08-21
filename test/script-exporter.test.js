import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMixAccumulator,
  createSoftLimiter,
  exportFilename,
  runScriptExport,
} from '../src/audio/script-exporter.js';

// ------------------------------------------------------------------ fixtures

function unit(overrides = {}) {
  return {
    key: `k${Math.random()}`,
    text: 'line',
    isFirstChunk: true,
    isLastChunk: true,
    anchor: 'sequential',
    leadPause: 0,
    gain: 1,
    pan: 0,
    filter: null,
    playbackRate: 1,
    estimatedDuration: 1,
    ...overrides,
  };
}

/** A stand-in for a rendered AudioBuffer: only `duration` is read. */
function buffer(duration) {
  return { duration, numberOfChannels: 1, sampleRate: 24000 };
}

/**
 * Records everything handed to the encoder so a test can ask where the audio
 * actually landed, rather than trusting the placement arithmetic twice.
 */
function recordingEncoder() {
  const windows = [];
  return {
    windows,
    finished: false,
    async encode(planes) {
      windows.push(planes.map((plane) => Float32Array.from(plane)));
    },
    async finish() {
      this.finished = true;
    },
    concat(channel = 0) {
      const total = windows.reduce((sum, w) => sum + w[channel].length, 0);
      const out = new Float32Array(total);
      let at = 0;
      for (const window of windows) {
        out.set(window[channel], at);
        at += window[channel].length;
      }
      return out;
    },
  };
}

function fixedRenderer(sampleRate, level = 0.5) {
  return async ({ placement }) => {
    const frames = Math.max(1, Math.round((placement.endAt - placement.startAt) * sampleRate));
    const plane = new Float32Array(frames).fill(level);
    return [plane, Float32Array.from(plane)];
  };
}

// ------------------------------------------------------------ placement parity

class AudioParamStub {
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(value) {
    this.value = value;
  }
  linearRampToValueAtTime(value) {
    this.value = value;
  }
  setTargetAtTime(value) {
    this.value = value;
  }
  cancelScheduledValues() {}
}

class AudioNodeStub {
  constructor() {
    this.connections = [];
  }
  connect(node) {
    this.connections.push(node);
    return node;
  }
  disconnect() {}
}

class SchedulerContextStub {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new AudioNodeStub();
  }
  _param(node, names) {
    for (const name of names) node[name] = new AudioParamStub();
    return node;
  }
  createGain() {
    const node = new AudioNodeStub();
    node.gain = new AudioParamStub(1);
    return node;
  }
  createStereoPanner() {
    return this._param(new AudioNodeStub(), ['pan']);
  }
  createBiquadFilter() {
    return this._param(new AudioNodeStub(), ['frequency', 'Q', 'gain']);
  }
  createDynamicsCompressor() {
    return this._param(new AudioNodeStub(), ['threshold', 'knee', 'ratio', 'attack', 'release']);
  }
  createAnalyser() {
    return new AudioNodeStub();
  }
  createBufferSource() {
    const node = new AudioNodeStub();
    node.playbackRate = new AudioParamStub(1);
    node.buffer = null;
    node.start = () => {};
    node.stop = () => {};
    return node;
  }
}

test('the exporter places a cluster exactly where the live scheduler would', async () => {
  globalThis.window = { AudioContext: SchedulerContextStub };
  const { PlaybackScheduler, createTimelineEdges, placeOnTimeline } = await import(
    '../src/audio/playback-scheduler.js'
  );

  // A plain line, an interrupter riding its tail, and a simultaneous speaker.
  const cluster = [
    unit({ anchor: 'sequential', leadPause: 0.24, trimTailSec: 0.3 }),
    unit({ anchor: 'prevTail', leadPause: -0.3, isFirstChunk: true }),
    unit({ anchor: 'prevHead', leadPause: 0.03, isFirstChunk: true }),
    unit({ anchor: 'chunk', leadPause: 0.07, isFirstChunk: false }),
  ];
  const durations = [2.4, 1.1, 1.6, 0.9];

  const scheduler = new PlaybackScheduler();
  const live = cluster.map((u, i) => scheduler.schedule(u, buffer(durations[i])));

  const edges = createTimelineEdges(0);
  const offline = cluster.map((u, i) => placeOnTimeline(edges, u, durations[i], 0));

  for (let i = 0; i < cluster.length; i++) {
    assert.equal(offline[i].startAt, live[i].startAt, `unit ${i} start`);
    assert.equal(offline[i].endAt, live[i].endAt, `unit ${i} end`);
    assert.equal(offline[i].naturalEnd, live[i].naturalEnd, `unit ${i} natural end`);
    assert.equal(offline[i].truncated, live[i].truncated, `unit ${i} truncation`);
  }

  // The interrupter really does start before its victim would have finished.
  assert.ok(offline[1].startAt < offline[0].naturalEnd);
  // The simultaneous speaker starts alongside the line it talks over.
  assert.ok(offline[2].startAt < offline[1].endAt);
});

// -------------------------------------------------------------------- mixer

test('the mixer sums overlapping writes at absolute frame offsets', () => {
  const acc = createMixAccumulator({ channels: 2 });
  acc.mix([Float32Array.from([1, 1, 1]), Float32Array.from([1, 1, 1])], 0);
  acc.mix([Float32Array.from([1, 1, 1]), Float32Array.from([1, 1, 1])], 2);

  const out = acc.drain();
  assert.deepEqual([...out[0]], [1, 1, 2, 1, 1]);
  assert.deepEqual([...out[1]], [1, 1, 2, 1, 1]);
});

test('a write beyond the tail leaves the gap as silence, not as a shortened file', () => {
  const acc = createMixAccumulator({ channels: 2 });
  acc.mix([Float32Array.from([1]), Float32Array.from([1])], 0);
  acc.mix([Float32Array.from([1]), Float32Array.from([1])], 4);

  const out = acc.drain();
  assert.equal(out[0].length, 5);
  assert.deepEqual([...out[0]], [1, 0, 0, 0, 1]);
});

test('taking a window commits it once and keeps the remainder addressable', () => {
  const acc = createMixAccumulator({ channels: 2 });
  acc.mix([Float32Array.from([1, 2, 3, 4]), Float32Array.from([1, 2, 3, 4])], 0);

  const first = acc.take(2);
  assert.deepEqual([...first[0]], [1, 2]);
  assert.equal(acc.origin, 2);

  // A later unit still addresses frames in absolute terms.
  acc.mix([Float32Array.from([10, 10]), Float32Array.from([10, 10])], 3);
  const rest = acc.drain();
  assert.deepEqual([...rest[0]], [3, 14, 10]);
});

test('the mixer refuses to write into audio it has already committed', () => {
  const acc = createMixAccumulator({ channels: 2 });
  acc.mix([Float32Array.from([1, 1, 1, 1]), Float32Array.from([1, 1, 1, 1])], 0);
  acc.take(3);
  assert.throws(() => acc.mix([Float32Array.from([1]), Float32Array.from([1])], 1), /already committed/);
});

test('growth past the initial capacity preserves what was already mixed', () => {
  const acc = createMixAccumulator({ channels: 2 });
  acc.mix([Float32Array.from([0.25]), Float32Array.from([0.25])], 0);

  const far = 1 << 17;
  acc.mix([Float32Array.from([0.5]), Float32Array.from([0.5])], far);

  const out = acc.drain();
  assert.equal(out[0].length, far + 1);
  assert.equal(out[0][0], 0.25);
  assert.equal(out[0][far], 0.5);
});

// ------------------------------------------------------------------ limiter

test('the limiter holds the ceiling and never passes full scale', () => {
  const limiter = createSoftLimiter({ sampleRate: 24000 });
  const loud = new Float32Array(4800).fill(1.6);
  const out = limiter.process([loud, Float32Array.from(loud)]);

  for (const value of out[0]) assert.ok(Math.abs(value) <= 1, 'sample exceeded full scale');
  // Past the attack the envelope has settled onto the ceiling.
  assert.ok(out[0][2400] < 0.9, 'limiter never pulled the level down');
});

test('limiter gain carries across windows instead of resetting each flush', () => {
  const limiter = createSoftLimiter({ sampleRate: 24000 });
  limiter.process([new Float32Array(2400).fill(1.6), new Float32Array(2400).fill(1.6)]);
  const reduced = limiter.gain;
  assert.ok(reduced < 1, 'first window should have pulled gain down');

  const next = limiter.process([new Float32Array(8).fill(1.6), new Float32Array(8).fill(1.6)]);
  // A fresh limiter would open at unity and let a loud transient through.
  assert.ok(Math.abs(next[0][0]) < 1, 'the second window started from an open gate');
  assert.ok(Math.abs(limiter.gain - reduced) < 0.05, 'gain jumped between windows');
});

// ------------------------------------------------------------- the whole run

test('a sequential script encodes every frame of its timeline exactly once', async () => {
  const sampleRate = 1000;
  const encoder = recordingEncoder();
  const clusters = [[unit({ leadPause: 0 })], [unit({ leadPause: 0.5 })], [unit({ leadPause: 0 })]];
  const durations = new Map(clusters.flat().map((u, i) => [u.key, [1, 2, 0.5][i]]));

  const result = await runScriptExport({
    clusters,
    sampleRate,
    encoder,
    sink: { close: async () => {} },
    requestUnit: (u) => Promise.resolve(buffer(durations.get(u.key))),
    renderUnit: fixedRenderer(sampleRate),
  });

  // MIN_LEAD pushes the first line to 0.03s; then 1s, a 0.5s beat, 2s, 0.5s.
  const expectedSeconds = 0.03 + 1 + 0.5 + 2 + 0.5;
  assert.equal(result.frames, Math.round(expectedSeconds * sampleRate));
  assert.equal(encoder.concat().length, result.frames);
  assert.equal(encoder.finished, true);

  // The 0.5s pause between line one and line two is genuinely silent.
  const audio = encoder.concat();
  const gapStart = Math.round(1.03 * sampleRate) + 2;
  assert.equal(audio[gapStart], 0);
  assert.ok(Math.abs(audio[Math.round(1.6 * sampleRate)]) > 0, 'line two should be sounding');
});

test('an overlap cluster is mixed, not serialised', async () => {
  const sampleRate = 1000;
  const encoder = recordingEncoder();
  const victim = unit({ anchor: 'sequential', leadPause: 0 });
  const interrupter = unit({ anchor: 'prevTail', leadPause: -0.4 });
  const durations = new Map([
    [victim.key, 2],
    [interrupter.key, 1],
  ]);

  await runScriptExport({
    clusters: [[victim, interrupter]],
    sampleRate,
    encoder,
    sink: { close: async () => {} },
    requestUnit: (u) => Promise.resolve(buffer(durations.get(u.key))),
    renderUnit: fixedRenderer(sampleRate, 0.4),
  });

  const audio = encoder.concat();
  // The interrupter lands 0.4s before the victim's natural end at 2.03s, so
  // both are sounding around 1.8s and the sum is louder than either alone.
  const together = Math.abs(audio[Math.round(1.8 * sampleRate)]);
  const alone = Math.abs(audio[Math.round(0.5 * sampleRate)]);
  assert.ok(together > alone * 1.5, `expected overlap to sum: ${together} vs ${alone}`);
});

test('cancelling stops requesting work and never closes the sink', async () => {
  const sampleRate = 1000;
  const controller = new AbortController();
  const requested = [];
  let closed = false;

  const clusters = Array.from({ length: 20 }, () => [unit()]);

  await assert.rejects(
    runScriptExport({
      clusters,
      sampleRate,
      encoder: recordingEncoder(),
      sink: {
        close: async () => {
          closed = true;
        },
      },
      requestUnit: (u) => {
        requested.push(u.key);
        if (requested.length === 3) controller.abort();
        return Promise.resolve(buffer(1));
      },
      renderUnit: fixedRenderer(sampleRate),
      signal: controller.signal,
    }),
    (err) => err.name === 'AbortError',
  );

  assert.equal(closed, false, 'a cancelled export must not finalise its file');
  // Prefetch runs ahead of the awaited cluster, but the run stops well short of
  // walking the whole script.
  assert.ok(requested.length < clusters.length, `kept requesting after abort: ${requested.length}`);
});

test('progress is reported in script order and reaches every unit', async () => {
  const sampleRate = 1000;
  const seen = [];
  const clusters = [[unit(), unit()], [unit()], [unit()]];

  await runScriptExport({
    clusters,
    sampleRate,
    encoder: recordingEncoder(),
    sink: { close: async () => {} },
    requestUnit: () => Promise.resolve(buffer(1)),
    renderUnit: fixedRenderer(sampleRate),
    onProgress: (status) => seen.push(status),
  });

  const completed = seen.map((s) => s.completed);
  assert.deepEqual(
    completed,
    [...completed].sort((a, b) => a - b),
    'progress went backwards',
  );
  assert.equal(seen.at(-1).completed, 4);
  assert.equal(seen.at(-1).total, 4);
  assert.equal(seen.at(-1).phase, 'saving');
  assert.deepEqual([...new Set(seen.map((s) => s.phase))], ['rendering', 'encoding', 'saving']);
});

test('an engine that stops accepting work fails the export loudly', async () => {
  await assert.rejects(
    runScriptExport({
      clusters: [[unit()]],
      sampleRate: 1000,
      encoder: recordingEncoder(),
      sink: { close: async () => {} },
      requestUnit: () => null,
      renderUnit: fixedRenderer(1000),
    }),
    /stopped accepting render requests/,
  );
});

// ----------------------------------------------------------------- filenames

test('the filename keeps the title readable and loses what a filesystem rejects', () => {
  assert.equal(exportFilename('Midnight Caravan', 'aac'), 'Midnight Caravan.aac');
  assert.equal(exportFilename('INT./EXT: "Scene" *1*', 'wav'), 'INT. EXT Scene 1.wav');
  assert.equal(exportFilename('', 'aac'), 'ScriptReader table read.aac');
  assert.equal(exportFilename(null, 'aac'), 'ScriptReader table read.aac');
  assert.ok(exportFilename('x'.repeat(400), 'aac').length <= 124);
});

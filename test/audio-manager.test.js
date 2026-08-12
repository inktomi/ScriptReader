import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAYBACK_STATES,
  ScreenplayAudioManager
} from '../src/audio/audio-manager.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

test.before(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    }
  });
});

test.after(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    delete globalThis.localStorage;
  }
});

function fakeEngine(overrides = {}) {
  return {
    isReady: true,
    isLoading: false,
    lastError: null,
    capabilities: {
      id: ENGINE_IDS.OPENAI,
      metered: true,
      onUnavailable: 'error',
      supportsSpeed: true,
      supportsInstructions: true,
      usesInstructionPitch: true,
      maxChunkChars: 4096,
      ...overrides.capabilities
    },
    onProgress(callback) {
      this.progressCallback = callback;
      return () => { this.progressCallback = null; };
    },
    dropPendingExcept() {},
    request() {},
    getCached() { return null; },
    ...overrides
  };
}

test('metered engines do not synthesize before Play', () => {
  const manager = new ScreenplayAudioManager();
  let requests = 0;
  manager.engine = fakeEngine({ request() { requests++; } });
  manager.scriptElements = [{ type: 'ACTION', character: 'NARRATOR', text: 'Opening' }];
  manager.prewarm();
  assert.equal(requests, 0);
});

test('Studio Local loads an installed engine and pre-renders before Play', async () => {
  const manager = new ScreenplayAudioManager();
  const requested = [];
  const engine = fakeEngine({
    isReady: false,
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
    async init() { this.isReady = true; },
    request(unit) {
      requested.push(unit.key);
      return Promise.resolve({ duration: 2 });
    }
  });
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = engine;
  manager.getChatterboxCacheStatus = async () => ({ installed: true });
  manager.scriptElements = [{}];
  manager._unitsForLine = line => line === 0
    ? [{ key: 'opening', estimatedDuration: 2, leadPause: 0 }]
    : null;

  await manager.prewarm();

  assert.equal(engine.isReady, true);
  assert.deepEqual(requested, ['opening']);
  assert.equal(manager.playbackState, PLAYBACK_STATES.IDLE);
});

test('Studio Local pre-render reaches character lines beyond the old six-unit limit', async () => {
  const manager = new ScreenplayAudioManager();
  const requested = [];
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
    request(unit) {
      requested.push(unit);
      return Promise.resolve();
    }
  });
  manager.scriptElements = Array.from({ length: 10 }, () => ({}));
  manager._unitsForLine = line => line >= 0 && line < 10
    ? [{
        key: `unit-${line}`,
        character: line < 7 ? 'NARRATOR' : 'RILEY',
        estimatedDuration: 2,
        leadPause: 0
      }]
    : null;

  await manager.prewarm();

  assert.equal(requested.length, 10);
  assert.ok(requested.some(unit => unit.character === 'RILEY'));
});

test('Studio Local keeps background render requests in bounded batches', async () => {
  const manager = new ScreenplayAudioManager();
  const completions = [];
  let requested = 0;
  let active = 0;
  let maxActive = 0;
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
    request() {
      requested++;
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise(resolve => {
        completions.push(() => {
          active--;
          resolve();
        });
      });
    }
  });
  manager.scriptElements = Array.from({ length: 14 }, () => ({}));
  manager._unitsForLine = line => line >= 0 && line < 14
    ? [{ key: `unit-${line}`, estimatedDuration: 1, leadPause: 0 }]
    : null;

  const prewarm = manager.prewarm();
  assert.equal(requested, 6);

  while (requested < 14 || completions.length > 0) {
    const batch = completions.splice(0);
    batch.forEach(complete => complete());
    await new Promise(resolve => setImmediate(resolve));
  }
  await prewarm;

  assert.equal(requested, 14);
  assert.equal(maxActive, 6);
});

test('Studio Local keeps filling its persistent render cache during playback', async () => {
  const manager = new ScreenplayAudioManager();
  const completions = [];
  let requested = 0;
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
    request() {
      requested++;
      return new Promise(resolve => completions.push(() => resolve({ duration: 1 })));
    }
  });
  manager.scriptElements = Array.from({ length: 8 }, () => ({}));
  manager._unitsForLine = line => line >= 0 && line < 8
    ? [{ key: `unit-${line}`, estimatedDuration: 1, leadPause: 0 }]
    : null;

  const prewarm = manager.prewarm();
  assert.equal(requested, 6);
  manager.playbackState = PLAYBACK_STATES.PLAYING;
  completions.splice(0).forEach(complete => complete());
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(requested, 8);
  completions.splice(0).forEach(complete => complete());
  await prewarm;
});

test('Studio Local enables Play once a safe runway is rendered, before 100 percent', async () => {
  const manager = new ScreenplayAudioManager();
  const completions = [];
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
    request() {
      return new Promise(resolve => completions.push(resolve));
    }
  });
  manager.scriptElements = Array.from({ length: 20 }, () => ({}));
  manager._unitsForLine = line => line >= 0 && line < 20
    ? [{ key: `unit-${line}`, estimatedDuration: 30, leadPause: 0 }]
    : null;
  const runwayStatus = manager._studioRunwayStatus.bind(manager);
  manager._studioRunwayStatus = (units, _renderRate, previousCanPlay) =>
    runwayStatus(units, 0.5, previousCanPlay);

  const prewarm = manager.prewarm();
  assert.equal(manager.renderStatus.canPlay, false);

  completions.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  completions.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(manager.renderStatus.canPlay, true);
  assert.ok(manager.renderStatus.percent < 100);

  while (completions.length > 0 || manager.renderStatus.active) {
    completions.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  await prewarm;
});

test('Studio Local does not begin playback before the safe runway is ready', async () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = fakeEngine({ capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false } });
  manager.scriptElements = [{}];
  manager.renderStatus = { ...manager.renderStatus, visible: true, canPlay: false };
  manager._studioPrewarmTask = {
    engine: manager.engine,
    unitGeneration: manager.prewarmGeneration,
    promise: new Promise(() => {})
  };
  let audioStarts = 0;
  manager._ensureAudio = async () => { audioStarts++; return {}; };

  await manager.play();

  assert.equal(audioStarts, 0);
  assert.equal(manager.playbackState, PLAYBACK_STATES.IDLE);
});

test('a superseded Studio Local load cannot pre-render a stale script', async () => {
  const manager = new ScreenplayAudioManager();
  let finishStatusCheck;
  const requested = [];
  const engine = fakeEngine({
    isReady: false,
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
    async init() { this.isReady = true; },
    request(unit) { requested.push(unit.key); }
  });
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = engine;
  manager.getChatterboxCacheStatus = () => new Promise(resolve => { finishStatusCheck = resolve; });
  manager.scriptElements = [{}];
  manager._unitsForLine = line => line === 0
    ? [{ key: 'stale-opening', estimatedDuration: 2, leadPause: 0 }]
    : null;

  const prewarm = manager.prewarm();
  manager.stop();
  finishStatusCheck({ installed: true });
  await prewarm;

  assert.deepEqual(requested, []);
});

test('switching engines cancels the old engine queue', () => {
  const manager = new ScreenplayAudioManager();
  let cancellations = 0;
  const old = fakeEngine({ dropPendingExcept() { cancellations++; } });
  manager.engineId = ENGINE_IDS.OPENAI;
  manager.engine = old;
  manager._engines.set(ENGINE_IDS.OPENAI, old);

  manager.setEngine(ENGINE_IDS.KOKORO);
  assert.ok(cancellations > 0);
});

test('runtime engine errors leave buffering and emit an actionable error', () => {
  const manager = new ScreenplayAudioManager();
  if (manager._unbindProgress) manager._unbindProgress();
  const error = Object.assign(new Error('billing stopped'), { code: 'quota' });
  const engine = fakeEngine({ lastError: error });
  manager.engine = engine;
  manager.engineId = ENGINE_IDS.OPENAI;
  manager._bindEngineProgress();
  manager.playbackState = PLAYBACK_STATES.BUFFERING;
  const events = [];
  manager.subscribe((event, data) => events.push({ event, data }));

  engine.progressCallback({ phase: 'error', message: error.message });

  assert.equal(manager.playbackState, PLAYBACK_STATES.IDLE);
  assert.equal(events.at(-1).event, 'engineError');
  assert.equal(events.at(-1).data.code, 'quota');
});

test('an isolated render warning does not cut off current playback', () => {
  const manager = new ScreenplayAudioManager();
  if (manager._unbindProgress) manager._unbindProgress();
  const engine = fakeEngine({ lastError: new Error('future line failed') });
  manager.engine = engine;
  manager.engineId = ENGINE_IDS.OPENAI;
  manager._bindEngineProgress();
  manager.playbackState = PLAYBACK_STATES.PLAYING;

  engine.progressCallback({ phase: 'warning', message: 'future line failed' });

  assert.equal(manager.playbackState, PLAYBACK_STATES.PLAYING);
});

test('a fatal engine error is surfaced and tears down paused playback', () => {
  const manager = new ScreenplayAudioManager();
  if (manager._unbindProgress) manager._unbindProgress();
  const error = Object.assign(new Error('key revoked'), { code: 'invalid_key', fatal: true });
  const engine = fakeEngine({ lastError: error });
  manager.engine = engine;
  manager.engineId = ENGINE_IDS.OPENAI;
  manager._bindEngineProgress();
  manager.playbackState = PLAYBACK_STATES.PAUSED;
  let stopped = 0;
  manager.scheduler = { stopAll() { stopped++; } };
  const events = [];
  manager.subscribe((event, data) => events.push({ event, data }));

  engine.progressCallback({ phase: 'error', message: error.message });

  assert.equal(manager.playbackState, PLAYBACK_STATES.IDLE);
  assert.equal(stopped, 1);
  assert.equal(events.at(-1).event, 'engineError');
});

test('Play awaits an already-loading engine and falls back when it fails', async () => {
  const manager = new ScreenplayAudioManager();
  manager.scriptElements = [{ type: 'ACTION', character: 'NARRATOR', text: 'Opening' }];
  manager._ensureAudio = async () => ({});
  let initCalls = 0;
  manager.engine = fakeEngine({
    isReady: false,
    isLoading: true,
    capabilities: { metered: false, onUnavailable: 'webspeech' },
    async init() {
      initCalls++;
      this.isLoading = false;
      throw new Error('model failed');
    }
  });
  let fallback = false;
  manager._runWebSpeech = () => { fallback = true; };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await manager.play();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(initCalls, 1);
  assert.equal(fallback, true);
  assert.equal(manager.usingWebSpeechFallback, true);
});

test('resuming paused playback reinitializes an engine that became unavailable', async () => {
  const manager = new ScreenplayAudioManager();
  manager.scriptElements = [{ type: 'ACTION', character: 'NARRATOR', text: 'Opening' }];
  manager.playbackState = PLAYBACK_STATES.PAUSED;
  manager.scheduler = {};
  manager._ensureAudio = async () => manager.scheduler;
  let initCalls = 0;
  manager.engine = fakeEngine({
    isReady: false,
    async init() {
      initCalls++;
      this.isReady = true;
    }
  });
  let restarted = 0;
  manager._beginNeuralPlayback = () => { restarted++; };

  await manager.play();

  assert.equal(initCalls, 1);
  assert.equal(restarted, 1);
});

test('Play uses Web Speech when no AudioContext scheduler can be created', async () => {
  const manager = new ScreenplayAudioManager();
  manager.scriptElements = [{ type: 'ACTION', character: 'NARRATOR', text: 'Opening' }];
  manager._ensureAudio = async () => null;
  let fallback = false;
  manager._runWebSpeech = () => { fallback = true; };

  await manager.play();
  assert.equal(fallback, true);
  assert.equal(manager.usingWebSpeechFallback, true);
});

test('overlap request pumping expands past the normal lookahead cap', () => {
  const manager = new ScreenplayAudioManager();
  const requested = [];
  const units = Array.from({ length: 40 }, (_, index) => ({
    key: `unit-${index}`,
    estimatedDuration: 0.1,
    leadPause: 0,
    playbackRate: 1
  }));
  manager.engine = fakeEngine({
    capabilities: { metered: false },
    request(unit) { requested.push(unit.key); }
  });
  manager.cursorLine = 0;
  manager.cursorUnit = 0;
  manager.scriptElements = Array.from({ length: 20 }, (_, index) => ({
    overlap: index === 0 ? null : { mode: 'simultaneous' }
  }));

  // Present a cluster longer than both the normal lookahead and the former
  // fixed 16-line traversal cap.
  manager._unitsForLine = line => line >= 0 && line < 20
    ? units.slice(line * 2, line * 2 + 2)
    : null;
  manager._pumpRequests();
  assert.equal(requested.length, 40);
});

test('ready runway counts simultaneous voices by timeline coverage, not sum', () => {
  const manager = new ScreenplayAudioManager();
  const units = [
    [{ key: 'left', playbackRate: 1, leadPause: 0, overlapMode: 'sequential' }],
    [{ key: 'right', playbackRate: 1, leadPause: 0, overlapMode: 'simultaneous' }]
  ];
  manager.scriptElements = [{}, {}];
  manager.cursorLine = 0;
  manager.cursorUnit = 0;
  manager._unitsForLine = line => units[line] || null;
  manager.engine = fakeEngine({ getCached() { return { duration: 1.6 }; } });

  assert.deepEqual(manager._readyRunway(), { seconds: 1.6, hitEnd: true });
});

test('OpenAI preview failure never auditions a browser voice', async () => {
  const manager = new ScreenplayAudioManager();
  const error = Object.assign(new Error('speech endpoint unavailable'), { code: 'network' });
  let browserSpeeches = 0;
  manager.webSpeechEngine.speakLine = () => { browserSpeeches++; };
  manager.scheduler = { stopAll() {} };
  manager._ensureAudio = async () => manager.scheduler;
  manager.engineId = ENGINE_IDS.OPENAI;
  manager.engine = fakeEngine({ request: async () => { throw error; } });
  const events = [];
  manager.subscribe((event, data) => events.push({ event, data }));

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await manager.previewVoice('marin', 'Preview this line.');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(browserSpeeches, 0);
  assert.equal(events.at(-1).event, 'engineError');
  assert.equal(events.at(-1).data.code, 'network');
});

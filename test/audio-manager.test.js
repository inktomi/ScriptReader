import assert from 'node:assert/strict';
import test from 'node:test';

import { PLAYBACK_STATES, ScreenplayAudioManager } from '../src/audio/audio-manager.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

test.before(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
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
      ...overrides.capabilities,
    },
    onProgress(callback) {
      this.progressCallback = callback;
      return () => {
        this.progressCallback = null;
      };
    },
    dropPendingExcept() {},
    request() {},
    getCached() {
      return null;
    },
    ...overrides,
  };
}

test('metered engines do not synthesize before Play', () => {
  const manager = new ScreenplayAudioManager();
  let requests = 0;
  manager.engine = fakeEngine({
    request() {
      requests++;
    },
  });
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
    async init() {
      this.isReady = true;
    },
    request(unit) {
      requested.push(unit.key);
      return Promise.resolve({ duration: 2 });
    },
  });
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = engine;
  manager.getChatterboxCacheStatus = async () => ({ installed: true });
  manager.scriptElements = [{}];
  manager._unitsForLine = (line) => (line === 0 ? [{ key: 'opening', estimatedDuration: 2, leadPause: 0 }] : null);

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
    },
  });
  manager.scriptElements = Array.from({ length: 10 }, () => ({}));
  manager._unitsForLine = (line) =>
    line >= 0 && line < 10
      ? [
          {
            key: `unit-${line}`,
            character: line < 7 ? 'NARRATOR' : 'RILEY',
            estimatedDuration: 2,
            leadPause: 0,
          },
        ]
      : null;

  await manager.prewarm();

  assert.equal(requested.length, 10);
  assert.ok(requested.some((unit) => unit.character === 'RILEY'));
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
      return new Promise((resolve) => {
        completions.push(() => {
          active--;
          resolve();
        });
      });
    },
  });
  manager.scriptElements = Array.from({ length: 14 }, () => ({}));
  manager._unitsForLine = (line) =>
    line >= 0 && line < 14 ? [{ key: `unit-${line}`, estimatedDuration: 1, leadPause: 0 }] : null;

  const prewarm = manager.prewarm();
  assert.equal(requested, 6);

  while (requested < 14 || completions.length > 0) {
    const batch = completions.splice(0);
    batch.forEach((complete) => {
      complete();
    });
    await new Promise((resolve) => setImmediate(resolve));
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
      return new Promise((resolve) => completions.push(() => resolve({ duration: 1 })));
    },
  });
  manager.scriptElements = Array.from({ length: 8 }, () => ({}));
  manager._unitsForLine = (line) =>
    line >= 0 && line < 8 ? [{ key: `unit-${line}`, estimatedDuration: 1, leadPause: 0 }] : null;

  const prewarm = manager.prewarm();
  assert.equal(requested, 6);
  manager.playbackState = PLAYBACK_STATES.PLAYING;
  completions.splice(0).forEach((complete) => {
    complete();
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requested, 8);
  completions.splice(0).forEach((complete) => {
    complete();
  });
  await prewarm;
});

test('Studio Local enables Play once a safe runway is rendered, before 100 percent', async () => {
  const manager = new ScreenplayAudioManager();
  const completions = [];
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
    request() {
      return new Promise((resolve) => completions.push(resolve));
    },
  });
  manager.scriptElements = Array.from({ length: 20 }, () => ({}));
  manager._unitsForLine = (line) =>
    line >= 0 && line < 20 ? [{ key: `unit-${line}`, estimatedDuration: 30, leadPause: 0 }] : null;
  const runwayStatus = manager._studioRunwayStatus.bind(manager);
  manager._studioRunwayStatus = (units, _renderRate, previousCanPlay) => runwayStatus(units, 0.5, previousCanPlay);

  const prewarm = manager.prewarm();
  assert.equal(manager.renderStatus.canPlay, false);

  completions.splice(0).forEach((resolve) => {
    resolve();
  });
  await new Promise((resolve) => setImmediate(resolve));
  completions.splice(0).forEach((resolve) => {
    resolve();
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.renderStatus.canPlay, true);
  assert.ok(manager.renderStatus.percent < 100);

  while (completions.length > 0 || manager.renderStatus.active) {
    completions.splice(0).forEach((resolve) => {
      resolve();
    });
    await new Promise((resolve) => setImmediate(resolve));
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
    promise: new Promise(() => {}),
  };
  let audioStarts = 0;
  manager._ensureAudio = async () => {
    audioStarts++;
    return {};
  };

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
    async init() {
      this.isReady = true;
    },
    request(unit) {
      requested.push(unit.key);
    },
  });
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = engine;
  manager.getChatterboxCacheStatus = () =>
    new Promise((resolve) => {
      finishStatusCheck = resolve;
    });
  manager.scriptElements = [{}];
  manager._unitsForLine = (line) =>
    line === 0 ? [{ key: 'stale-opening', estimatedDuration: 2, leadPause: 0 }] : null;

  const prewarm = manager.prewarm();
  manager.stop();
  finishStatusCheck({ installed: true });
  await prewarm;

  assert.deepEqual(requested, []);
});

test('switching engines cancels the old engine queue', () => {
  const manager = new ScreenplayAudioManager();
  let cancellations = 0;
  const old = fakeEngine({
    dropPendingExcept() {
      cancellations++;
    },
  });
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
  manager.scheduler = {
    stopAll() {
      stopped++;
    },
  };
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
    },
  });
  let fallback = false;
  manager._runWebSpeech = () => {
    fallback = true;
  };

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
    },
  });
  let restarted = 0;
  manager._beginNeuralPlayback = () => {
    restarted++;
  };

  await manager.play();

  assert.equal(initCalls, 1);
  assert.equal(restarted, 1);
});

/**
 * The Studio Local canPlay gate exists to protect a cold start, not a resume.
 * A pause does not clear canPlay, but an in-between voice or cast edit does
 * (_invalidateUnits sets it false) -- and editing a cast while paused is
 * ordinary use, not an edge case. Before this fix, transport-bar enabled Play
 * whenever the state was not IDLE, but play() still applied the Chatterbox
 * canPlay gate to a PAUSED resume -- an enabled button that silently
 * re-armed prewarm and did nothing when clicked.
 */
test('resuming paused Studio Local playback is not blocked by a stale canPlay', async () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.hybridCasting = false;
  manager.scriptElements = [{ type: 'DIALOGUE', character: 'VALENTINE', text: 'Kira, breach is done.' }];
  manager.playbackState = PLAYBACK_STATES.PAUSED;
  manager.scheduler = {};
  manager._ensureAudio = async () => manager.scheduler;
  manager.engine = fakeEngine({ capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false } });
  // A voice edit made mid-pause, not a cold script load.
  manager.renderStatus = { ...manager.renderStatus, visible: true, canPlay: false };

  let prewarmCalls = 0;
  manager.prewarm = () => {
    prewarmCalls++;
    return null;
  };
  let restarted = 0;
  manager._beginNeuralPlayback = () => {
    restarted++;
  };
  // The resume branch under test calls the real _startTick(), which would
  // otherwise leave a live setInterval running past the end of this test.
  let ticksStarted = 0;
  manager._startTick = () => {
    ticksStarted++;
  };

  await manager.play();

  assert.equal(prewarmCalls, 0, 'a resume must not re-hit the cold-start gate');
  assert.equal(restarted, 0, 'a resume must not restart the timeline from scratch');
  assert.equal(ticksStarted, 1);
  assert.equal(manager.playbackState, PLAYBACK_STATES.PLAYING);
});

test('Play uses Web Speech when no AudioContext scheduler can be created', async () => {
  const manager = new ScreenplayAudioManager();
  manager.scriptElements = [{ type: 'ACTION', character: 'NARRATOR', text: 'Opening' }];
  manager._ensureAudio = async () => null;
  let fallback = false;
  manager._runWebSpeech = () => {
    fallback = true;
  };

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
    playbackRate: 1,
  }));
  manager.engine = fakeEngine({
    capabilities: { metered: false },
    request(unit) {
      requested.push(unit.key);
    },
  });
  manager.cursorLine = 0;
  manager.cursorUnit = 0;
  manager.scriptElements = Array.from({ length: 20 }, (_, index) => ({
    overlap: index === 0 ? null : { mode: 'simultaneous' },
  }));

  // Present a cluster longer than both the normal lookahead and the former
  // fixed 16-line traversal cap.
  manager._unitsForLine = (line) => (line >= 0 && line < 20 ? units.slice(line * 2, line * 2 + 2) : null);
  manager._pumpRequests();
  assert.equal(requested.length, 40);
});

test('ready runway counts simultaneous voices by timeline coverage, not sum', () => {
  const manager = new ScreenplayAudioManager();
  const units = [
    [{ key: 'left', playbackRate: 1, leadPause: 0, overlapMode: 'sequential' }],
    [{ key: 'right', playbackRate: 1, leadPause: 0, overlapMode: 'simultaneous' }],
  ];
  manager.scriptElements = [{}, {}];
  manager.cursorLine = 0;
  manager.cursorUnit = 0;
  manager._unitsForLine = (line) => units[line] || null;
  manager.engine = fakeEngine({
    getCached() {
      return { duration: 1.6 };
    },
  });

  assert.deepEqual(manager._readyRunway(), { seconds: 1.6, hitEnd: true });
});

test('OpenAI preview failure never auditions a browser voice', async () => {
  const manager = new ScreenplayAudioManager();
  const error = Object.assign(new Error('speech endpoint unavailable'), { code: 'network' });
  let browserSpeeches = 0;
  manager.webSpeechEngine.speakLine = () => {
    browserSpeeches++;
  };
  manager.scheduler = { stopAll() {} };
  manager._ensureAudio = async () => manager.scheduler;
  manager.engineId = ENGINE_IDS.OPENAI;
  manager.engine = fakeEngine({
    request: async () => {
      throw error;
    },
  });
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

test('hybrid casting routes narration to Kokoro and character dialogue to Chatterbox', () => {
  const manager = new ScreenplayAudioManager();
  manager.setEngine(ENGINE_IDS.CHATTERBOX);
  manager.hybridCasting = true;

  const actionElement = { type: 'ACTION', character: 'NARRATOR', text: 'Rain lashes against the glass.' };
  const dialogueElement = { type: 'DIALOGUE', character: 'VALENTINE', text: 'Kira, breach is done.' };

  const actionEngine = manager._engineForElement(actionElement);
  const dialogueEngine = manager._engineForElement(dialogueElement);

  assert.equal(actionEngine.capabilities.id, ENGINE_IDS.KOKORO);
  assert.equal(dialogueEngine.capabilities.id, ENGINE_IDS.CHATTERBOX);
});

/**
 * A hybrid cast is two engines deep, but only the selected one used to be
 * loaded. The narration engine then answered every render request with a silent
 * null, the scheduler found no buffer for the opening action line, and playback
 * sat in BUFFERING forever behind a bar that read "100% — ready".
 */
test('hybrid casting loads the narration engine, not just the selected one', async () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.hybridCasting = true;
  manager.scheduler = {};
  manager._ensureAudio = async () => manager.scheduler;

  manager.engine = fakeEngine({ capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false } });
  let narratorInits = 0;
  const narrator = fakeEngine({
    isReady: false,
    capabilities: { id: ENGINE_IDS.KOKORO, metered: false },
    async init() {
      narratorInits++;
      this.isReady = true;
    },
  });
  manager._engines.set(ENGINE_IDS.KOKORO, narrator);

  manager.scriptElements = [
    { type: 'ACTION', character: 'NARRATOR', text: 'Rain lashes against the glass.' },
    { type: 'DIALOGUE', character: 'VALENTINE', text: 'Kira, breach is done.' },
  ];

  let started = 0;
  manager._beginNeuralPlayback = () => {
    started++;
  };
  await manager.play();

  assert.equal(narratorInits, 1);
  assert.equal(started, 1);
});

test('a narration engine that will not load reports it instead of buffering forever', async () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.hybridCasting = true;
  manager.scheduler = {};
  manager._ensureAudio = async () => manager.scheduler;

  manager.engine = fakeEngine({ capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false } });
  manager._engines.set(
    ENGINE_IDS.KOKORO,
    fakeEngine({
      isReady: false,
      capabilities: { id: ENGINE_IDS.KOKORO, metered: false },
      async init() {
        throw new Error('Model weights unavailable');
      },
    }),
  );

  manager.scriptElements = [{ type: 'ACTION', character: 'NARRATOR', text: 'Rain lashes against the glass.' }];

  const events = [];
  manager.subscribe((event, data) => events.push({ event, data }));
  let started = 0;
  manager._beginNeuralPlayback = () => {
    started++;
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await manager.play();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(started, 0);
  const error = events.findLast((entry) => entry.event === 'engineError');
  assert.ok(error, 'a failed narration engine must be reported');
  // The listener never asked for the split, so the fix is one click away rather
  // than a hunt through Voice Engine settings.
  assert.equal(error.data.action, 'disableHybridCasting');
  assert.match(error.data.message, /the narration/);
  assert.equal(manager.playbackState, PLAYBACK_STATES.IDLE);
});

test('the Studio pre-render plan counts narration units, not just Chatterbox ones', () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.hybridCasting = true;
  manager.engine = fakeEngine({ capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false } });
  manager._engines.set(
    ENGINE_IDS.KOKORO,
    fakeEngine({
      capabilities: { id: ENGINE_IDS.KOKORO, metered: false },
    }),
  );

  manager.scriptElements = [
    { type: 'ACTION', character: 'NARRATOR', text: 'Rain lashes against the glass.' },
    { type: 'DIALOGUE', character: 'VALENTINE', text: 'Kira, breach is done.' },
  ];

  const engineIds = manager._studioRenderUnits().units.map((unit) => unit.engineId);
  assert.ok(engineIds.includes(ENGINE_IDS.KOKORO), 'narration must be in the plan the progress bar reports against');
  assert.ok(engineIds.includes(ENGINE_IDS.CHATTERBOX));
});

/**
 * The pump self-heals a cold engine, but a failed init clears its own
 * single-flight latch — so an unconditional retry would spawn a worker and a
 * model download on every 60 ms tick.
 */
test('a cold engine is started once per run, not once per tick', () => {
  const manager = new ScreenplayAudioManager();
  let inits = 0;

  // The selected engine is up — `_pumpRequests` gates on that. The narration
  // engine underneath it is the cold one.
  manager.engine = fakeEngine({ capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false } });
  const cold = fakeEngine({
    isReady: false,
    capabilities: { id: ENGINE_IDS.KOKORO, metered: false },
    async init() {
      inits++;
      throw new Error('weights unavailable');
    },
    request: () => null,
  });
  manager._engineForUnit = () => cold;

  manager.scriptElements = [{ type: 'ACTION', character: 'NARRATOR', text: 'Opening' }];
  manager._unitsForLine = (line) => (line === 0 ? [{ key: 'unit-0', estimatedDuration: 4, leadPause: 0 }] : null);

  for (let tick = 0; tick < 25; tick++) manager._pumpRequests();
  assert.equal(inits, 1);

  // A fresh run is allowed one more attempt.
  manager._autoInitAttempted.clear();
  manager._pumpRequests();
  assert.equal(inits, 2);
});

test('buffering that never progresses is reported rather than spun on forever', () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = fakeEngine({ capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false } });
  manager.scriptElements = [{ type: 'ACTION', character: 'NARRATOR', text: 'Opening' }];
  manager._unitsForLine = (line) =>
    line === 0 ? [{ key: 'unit-0', estimatedDuration: 4, leadPause: 0, engineId: ENGINE_IDS.CHATTERBOX }] : null;
  manager.scheduler = { bufferedAhead: 0, currentTime: 0, stopAll() {} };
  manager.playbackState = PLAYBACK_STATES.BUFFERING;

  const events = [];
  manager.subscribe((event, data) => events.push({ event, data }));

  // Nothing has been rendered and the deadline has passed.
  manager.stallDeadline = Date.now() - 1;
  manager._pumpState();

  const error = events.findLast((entry) => entry.event === 'engineError');
  assert.ok(error, 'a permanently starved pipeline must surface an error');
  assert.equal(error.data.code, 'render_stalled');
  assert.equal(manager.playbackState, PLAYBACK_STATES.IDLE);
});

test('a stall watchdog that sees progress rearms instead of firing', () => {
  const manager = new ScreenplayAudioManager();
  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.KOKORO, metered: false },
    getCached: () => ({ duration: 12 }),
  });
  manager.scriptElements = [{ type: 'ACTION', character: 'NARRATOR', text: 'Opening' }];
  manager._unitsForLine = (line) => (line === 0 ? [{ key: 'unit-0', estimatedDuration: 4, leadPause: 0 }] : null);
  manager.scheduler = { bufferedAhead: 0, currentTime: 0 };
  manager.playbackState = PLAYBACK_STATES.BUFFERING;

  const events = [];
  manager.subscribe((event, data) => events.push({ event, data }));
  manager.stallDeadline = Date.now() - 1;
  manager._pumpState();

  assert.equal(events.filter((entry) => entry.event === 'engineError').length, 0);
  assert.equal(manager.playbackState, PLAYBACK_STATES.BUFFERING);
  assert.ok(manager.stallDeadline > Date.now(), 'the watchdog must rearm on progress');
});

test('short script safe runway calculates small cushion without forcing 5-minute requirement', () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;

  // Short script with 30 seconds total audio
  const units = [
    { key: 'u1', estimatedDuration: 10 },
    { key: 'u2', estimatedDuration: 10 },
    { key: 'u3', estimatedDuration: 10 },
  ];

  // At 0 render rate, required runway is total (30s)
  const initial = manager._studioRunwayStatus(units, 0);
  assert.equal(initial.requiredSeconds, 30);
  assert.equal(initial.canPlay, false);

  // Once first 10s unit is prepared and measured render rate is faster than real time (1.2x)
  manager._preparedStudioKeys.add('u1');
  const readyStatus = manager._studioRunwayStatus(units, 1.2);
  assert.equal(readyStatus.canPlay, true);
});

/**
 * Seeking repositioning the playhead within the same script preserves prewarm
 * state and resumes playback without resetting canPlay or percent.
 */
test('seeking under Studio Local preserves prewarm and resumes playing', async () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
  });
  manager.scriptElements = [
    { type: 'DIALOGUE', character: 'VALENTINE', text: 'Line 0' },
    { type: 'DIALOGUE', character: 'VALENTINE', text: 'Line 1' },
    { type: 'DIALOGUE', character: 'VALENTINE', text: 'Line 2' },
  ];
  manager._unitsForLine = (line) => [
    {
      key: `unit-${line}`,
      estimatedDuration: 2,
      leadPause: 0,
      engineId: ENGINE_IDS.CHATTERBOX,
    },
  ];

  // Script is already rendered and ready to play
  manager._preparedStudioKeys.add('unit-0');
  manager._preparedStudioKeys.add('unit-1');
  manager._preparedStudioKeys.add('unit-2');
  manager.renderStatus = {
    visible: true,
    active: false,
    canPlay: true,
    percent: 100,
    message: 'Studio Local audio ready',
  };

  let playbackStartedAt = null;
  manager._ensureAudio = async () => ({
    stopAll() {},
    resetTimeline() {},
    currentTime: 0,
  });
  manager._beginNeuralPlayback = (fromIndex) => {
    playbackStartedAt = fromIndex;
    manager.playbackState = PLAYBACK_STATES.PLAYING;
  };

  // Start playing at line 0
  await manager.play();
  assert.equal(manager.playbackState, PLAYBACK_STATES.PLAYING);
  assert.equal(playbackStartedAt, 0);

  // Seek to line 2 while playing
  manager.seek(2);
  await new Promise((resolve) => setImmediate(resolve));

  // Playback must resume at line 2 and canPlay must not be reset to false
  assert.equal(manager.currentIndex, 2);
  assert.equal(manager.renderStatus.canPlay, true);
  assert.equal(playbackStartedAt, 2);
});

/**
 * Dropped or aborted requests (from cast edits or seeks) must not be counted as
 * prepared or advance the completed count, preventing false runway inflation.
 */
test('dropped prewarm requests are not marked as prepared in Studio render store', async () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
    request(unit) {
      if (unit.key === 'unit-dropped') {
        return Promise.reject(new Error('Render request dropped'));
      }
      return Promise.resolve({ duration: 2 });
    },
  });
  manager.scriptElements = [
    { type: 'DIALOGUE', character: 'VALENTINE', text: 'Line 0' },
    { type: 'DIALOGUE', character: 'VALENTINE', text: 'Line 1' },
  ];
  manager._unitsForLine = (line) => [
    {
      key: line === 0 ? 'unit-ok' : 'unit-dropped',
      estimatedDuration: 2,
      leadPause: 0,
      engineId: ENGINE_IDS.CHATTERBOX,
    },
  ];

  await manager._queueStudioPrewarm(manager.engine, manager.prewarmGeneration);

  assert.ok(manager._preparedStudioKeys.has('unit-ok'), 'fulfilled unit must be marked prepared');
  assert.ok(!manager._preparedStudioKeys.has('unit-dropped'), 'dropped unit must not be marked prepared');
  assert.equal(manager.renderStatus.completed, 1);
});

/**
 * Flushing pending requests drops lookahead across all engines in a hybrid cast,
 * ensuring secondary engines do not continue synthesising abandoned narration.
 */
test('flushing pending requests drops lookahead across all engines in a hybrid cast', () => {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.CHATTERBOX;
  manager.hybridCasting = true;

  const chatterboxDropped = [];
  const kokoroDropped = [];

  const chatterboxEngine = fakeEngine({
    capabilities: { id: ENGINE_IDS.CHATTERBOX, metered: false },
    dropPendingExcept(keys) {
      chatterboxDropped.push(keys);
    },
  });
  const kokoroEngine = fakeEngine({
    capabilities: { id: ENGINE_IDS.KOKORO, metered: false },
    dropPendingExcept(keys) {
      kokoroDropped.push(keys);
    },
  });

  manager.engine = chatterboxEngine;
  manager._engines.set(ENGINE_IDS.CHATTERBOX, chatterboxEngine);
  manager._engines.set(ENGINE_IDS.KOKORO, kokoroEngine);

  manager.scriptElements = [
    { type: 'ACTION', character: 'NARRATOR', text: 'Scene opening' },
    { type: 'DIALOGUE', character: 'VALENTINE', text: 'Dialogue line' },
  ];

  // Flush on cast change
  manager.setVoiceAssignment('VALENTINE', { voiceId: 'v1' });
  assert.equal(chatterboxDropped.length, 1);
  assert.equal(kokoroDropped.length, 1);

  // Flush on seek
  manager.seek(1);
  assert.equal(chatterboxDropped.length, 2);
  assert.equal(kokoroDropped.length, 2);
});

test('RunPod pre-renders in the background ASAP before Play when configured with an API key', async () => {
  const manager = new ScreenplayAudioManager();
  const requested = [];
  const engine = fakeEngine({
    isReady: false,
    capabilities: { id: ENGINE_IDS.RUNPOD, label: 'RunPod GPU (Cloud L40S)', metered: false },
    getApiKey: () => 'valid-runpod-key',
    async init() {
      this.isReady = true;
    },
    request(unit) {
      requested.push(unit.key);
      return Promise.resolve({ duration: 2.5 });
    },
  });

  manager.engineId = ENGINE_IDS.RUNPOD;
  manager.engine = engine;
  manager._engines.set(ENGINE_IDS.RUNPOD, engine);
  manager.scriptElements = [{ type: 'DIALOGUE', character: 'HERO', text: 'To be or not to be.' }];
  manager._unitsForLine = (line) =>
    line === 0 ? [{ key: 'runpod-unit-1', estimatedDuration: 2.5, leadPause: 0 }] : null;

  await manager.prewarm();

  assert.equal(engine.isReady, true);
  assert.deepEqual(requested, ['runpod-unit-1']);
  assert.equal(manager.renderStatus.visible, true);
  assert.equal(manager.renderStatus.engineLabel, 'RunPod GPU (Cloud L40S)');
  assert.equal(manager.renderStatus.completed, 1);
  assert.equal(manager.playbackState, PLAYBACK_STATES.IDLE);
});

test('replacing a RunPod script releases the previous script-owned memory', () => {
  const manager = new ScreenplayAudioManager();
  let releases = 0;
  manager.engineId = ENGINE_IDS.RUNPOD;
  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.RUNPOD, metered: true },
    release() {
      releases++;
    },
  });
  manager.scriptElements = [{ type: 'ACTION', text: 'Previous script' }];

  manager.setScript([{ type: 'ACTION', text: 'Next script' }]);

  assert.equal(releases, 1);
});

test('Play gates on runway readiness under RunPod when unrendered', async () => {
  const manager = new ScreenplayAudioManager();
  let prewarmCalled = false;
  const engine = fakeEngine({
    isReady: true,
    capabilities: { id: ENGINE_IDS.RUNPOD, label: 'RunPod GPU (Cloud L40S)', metered: false },
  });

  manager.engineId = ENGINE_IDS.RUNPOD;
  manager.engine = engine;
  manager.scriptElements = [{ type: 'DIALOGUE', character: 'HERO', text: 'Line one' }];
  manager.renderStatus = { visible: true, active: true, canPlay: false };
  manager.prewarm = () => {
    prewarmCalled = true;
  };

  await manager.play();

  assert.equal(prewarmCalled, true, 'play() must trigger prewarm and wait when canPlay is false');
  assert.equal(manager.playbackState, PLAYBACK_STATES.IDLE);
});

test('RunPod and Studio prewarm cleanly skip unspeakable parentheticals without failing the render pass', async () => {
  const manager = new ScreenplayAudioManager();
  const requested = [];
  const engine = fakeEngine({
    isReady: true,
    capabilities: { id: ENGINE_IDS.RUNPOD, label: 'RunPod GPU (Cloud L40S)', metered: false },
    async init() {},
    request(unit) {
      requested.push(unit.text);
      return Promise.resolve({ duration: 2 });
    },
  });

  manager.engineId = ENGINE_IDS.RUNPOD;
  manager.engine = engine;
  manager.scriptElements = [
    { type: 'SCENE_HEADING', text: 'INT. OFFICE - DAY' },
    { type: 'DIALOGUE', character: 'SARAH', text: '(beat)' },
    { type: 'DIALOGUE', character: 'SARAH', text: 'I have good news.' },
    { type: 'DIALOGUE', character: 'MARK', text: '...' },
    { type: 'DIALOGUE', character: 'MARK', text: '(sighs)' },
    { type: 'DIALOGUE', character: 'MARK', text: 'Tell me everything.' },
  ];

  await manager.prewarm();

  assert.deepEqual(requested, ['Interior: Office, day.', 'I have good news.', 'Tell me everything.']);
  assert.equal(manager.renderStatus.error, null);
  assert.equal(manager.renderStatus.completed, 3);
  assert.equal(manager.renderStatus.total, 3);
});

/**
 * A batching remote engine only reaches full speed once its queue holds enough
 * units to form several concurrent requests. Awaiting a single group of six
 * left a fleet of GPU workers idle behind one request in flight, so the prewarm
 * loop now queues further groups ahead of the one it is waiting on.
 */
function prewarmHarness(capabilities, lineCount) {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.RUNPOD;
  const requested = [];
  const pending = [];

  manager.engine = fakeEngine({
    capabilities: { id: ENGINE_IDS.RUNPOD, metered: false, ...capabilities },
    request(unit) {
      requested.push(unit.key);
      return new Promise((resolve) => {
        pending.push(() => resolve({ duration: 2 }));
      });
    },
  });
  manager.scriptElements = Array.from({ length: lineCount }, (_, index) => ({
    type: 'DIALOGUE',
    character: 'VALENTINE',
    text: `Line ${index}`,
  }));
  manager._unitsForLine = (line) =>
    line < lineCount
      ? [{ key: `unit-${line}`, estimatedDuration: 2, leadPause: 0, engineId: ENGINE_IDS.RUNPOD }]
      : null;

  // Requests arrive in waves, so releasing one snapshot is not enough to finish.
  const drain = async (prewarm) => {
    let settled = false;
    const done = prewarm.then(() => {
      settled = true;
    });
    for (let guard = 0; !settled && guard < 200; guard++) {
      for (const resolve of pending.splice(0)) resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
    return done;
  };

  return { manager, requested, drain };
}

test('a batching engine is handed more than one request worth of work at a time', async () => {
  const { manager, requested, drain } = prewarmHarness({ concurrency: 6, batchSize: 24 }, 40);

  const prewarm = manager._queueStudioPrewarm(manager.engine, manager.prewarmGeneration);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    requested.length > 6,
    `expected the queue to be filled past the awaited group, saw ${requested.length} requests`,
  );
  assert.equal(requested.length, 40, 'every unit inside the lookahead window is queued up front');

  await drain(prewarm);
  assert.equal(manager.renderStatus.completed, 40);
});

test('a non-batching engine still receives exactly one group at a time', async () => {
  const { manager, requested, drain } = prewarmHarness({ concurrency: 1 }, 40);

  const prewarm = manager._queueStudioPrewarm(manager.engine, manager.prewarmGeneration);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requested.length, 6, 'a local engine must not be flooded with the whole script');

  await drain(prewarm);
  assert.equal(manager.renderStatus.completed, 40);
});

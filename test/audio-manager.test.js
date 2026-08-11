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

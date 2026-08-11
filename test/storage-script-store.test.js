import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptStore } from '../src/screenplay/script-store.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';
import {
  generateScriptKey,
  generateLegacyScriptKey,
  loadScriptCastConfig,
  restoreCastBackup,
  saveScriptCastConfig
} from '../src/utils/storage.js';

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
  clear() { this.data.clear(); }
}

const makeScript = (title, first, last = 'ending') => ({
  title,
  elements: [
    { type: 'ACTION', character: 'NARRATOR', text: first, parenthetical: '' },
    { type: 'ACTION', character: 'NARRATOR', text: last, parenthetical: '' }
  ],
  characters: [],
  scenes: []
});

test.beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

test.afterEach(() => {
  delete globalThis.localStorage;
});

test('script keys include the full script rather than only the opening prefix', () => {
  const opening = 'the same thirty character opening text';
  assert.notEqual(
    generateScriptKey(makeScript('Same title', opening, 'ending A')),
    generateScriptKey(makeScript('Same title', opening, 'ending B'))
  );
});

test('narrator choices are retained independently per engine', () => {
  const store = new ScriptStore();
  store.currentScript = makeScript('Narrators', 'Opening');
  store.scriptKey = generateScriptKey(store.currentScript);

  store.updateNarratorVoice('bf_emma', ENGINE_IDS.KOKORO);
  store.updateNarratorVoice('nova', ENGINE_IDS.OPENAI);

  assert.equal(store.getNarratorVoice(ENGINE_IDS.KOKORO), 'bf_emma');
  assert.equal(store.getNarratorVoice(ENGINE_IDS.OPENAI), 'nova');
  const saved = loadScriptCastConfig(store.scriptKey);
  assert.equal(saved.narratorVoiceIds[ENGINE_IDS.OPENAI], 'nova');
});

test('bulk cast save preserves per-engine character voice maps', () => {
  const store = new ScriptStore();
  store.currentScript = makeScript('Cast', 'Opening');
  store.scriptKey = generateScriptKey(store.currentScript);
  const cast = new Map([['ALICE', {
    voiceId: 'af_bella',
    voiceIds: { [ENGINE_IDS.KOKORO]: 'af_bella', [ENGINE_IDS.OPENAI]: 'shimmer' }
  }]]);

  store.updateCast({
    narratorVoiceId: 'nova',
    narratorEngineId: ENGINE_IDS.OPENAI,
    castAssignments: cast
  });

  assert.equal(
    loadScriptCastConfig(store.scriptKey).castAssignments.get('ALICE').voiceIds[ENGINE_IDS.OPENAI],
    'shimmer'
  );
});

test('loading another script cancels a pending position save from the old script', async () => {
  const store = new ScriptStore();
  const first = makeScript('First', 'Opening A');
  first.elements.push({ type: 'ACTION', character: 'NARRATOR', text: 'third' });
  store.setScriptData(first, { scriptKey: generateScriptKey(first), scriptType: 'custom' });
  store.setActiveLine(2);

  const second = makeScript('Second', 'Opening B');
  const secondKey = generateScriptKey(second);
  store.setScriptData(second, { scriptKey: secondKey, scriptType: 'custom' });
  await new Promise(resolve => setTimeout(resolve, 450));

  assert.equal(loadScriptCastConfig(secondKey).activeLineIndex, 0);
});

test('legacy cloud narrator IDs migrate into the OpenAI slot', () => {
  const script = makeScript('Legacy cloud', 'Opening');
  const key = generateScriptKey(script);
  saveScriptCastConfig(key, {
    narratorVoiceId: 'nova',
    narratorVoiceIds: null,
    castAssignments: new Map(),
    castVersion: 2
  });

  const store = new ScriptStore();
  store.setScriptData(script, { scriptKey: key, scriptType: 'custom' });
  store.updateNarratorVoice('bf_emma', ENGINE_IDS.KOKORO);
  assert.equal(store.getNarratorVoice(ENGINE_IDS.OPENAI), 'nova');
});

test('legacy-key cast migration creates a working Undo backup under the new key', () => {
  const script = {
    ...makeScript('Legacy cast', 'Opening'),
    characters: [{ name: 'ALICE', lineCount: 1, sampleLine: 'Hello.' }]
  };
  const legacyKey = generateLegacyScriptKey(script);
  const strongKey = generateScriptKey(script);
  saveScriptCastConfig(legacyKey, {
    narratorVoiceId: 'bm_george',
    castAssignments: new Map([['ALICE', {
      voiceId: 'am_adam',
      pitchOffset: 0,
      speedMultiplier: 1,
      tonePreset: 'natural',
      auto: true
    }]]),
    castVersion: 1
  });

  const store = new ScriptStore();
  store.setScriptData(script, {
    scriptKey: strongKey,
    scriptType: 'custom',
    legacyConfigKey: legacyKey
  });
  assert.ok(store.pendingCastMigration);
  assert.equal(restoreCastBackup(strongKey), true);
  assert.equal(loadScriptCastConfig(strongKey).castAssignments.get('ALICE').voiceId, 'am_adam');
});

test('a new script never inherits an unrelated config that only shares its legacy key', () => {
  const opening = 'the same thirty character opening text';
  const first = makeScript('Shared title', opening, 'ending A');
  const second = makeScript('Shared title', opening, 'ending B');
  const legacyKey = generateLegacyScriptKey(first);
  assert.equal(legacyKey, generateLegacyScriptKey(second));

  saveScriptCastConfig(legacyKey, {
    narratorVoiceId: 'bm_george',
    castAssignments: new Map(),
    activeLineIndex: 1,
    castVersion: 2
  });

  const store = new ScriptStore();
  store.setScriptData(second, {
    scriptKey: generateScriptKey(second),
    scriptType: 'custom'
  });

  assert.equal(store.narratorVoiceId, 'bf_emma');
  assert.equal(store.activeLineIndex, 0);
  assert.equal(store.pendingLegacyConfig.legacyKey, legacyKey);

  store.setScriptData(second, {
    scriptKey: generateScriptKey(second),
    scriptType: 'custom',
    legacyConfigKey: legacyKey
  });
  assert.equal(store.narratorVoiceId, 'bm_george');
  assert.equal(store.activeLineIndex, 1);
});

test('sidebar auto-cast changes only the active engine voice slots', () => {
  const store = new ScriptStore();
  store.currentScript = {
    ...makeScript('Cast', 'Opening'),
    characters: [{ name: 'ALICE', lineCount: 1, sampleLine: 'Hello.' }]
  };
  store.scriptKey = generateScriptKey(store.currentScript);
  store.narratorVoiceId = 'bf_emma';
  store.narratorVoiceIds = {
    [ENGINE_IDS.KOKORO]: 'bf_emma',
    [ENGINE_IDS.OPENAI]: 'shimmer'
  };
  store.castAssignments.set('ALICE', {
    ...store.castAssignments.get('ALICE'),
    voiceId: 'af_bella',
    voiceIds: {
      [ENGINE_IDS.KOKORO]: 'af_bella',
      [ENGINE_IDS.OPENAI]: 'shimmer'
    }
  });

  store.autoCastCurrentScript(ENGINE_IDS.OPENAI);

  assert.equal(store.getNarratorVoice(ENGINE_IDS.KOKORO), 'bf_emma');
  assert.notEqual(store.getNarratorVoice(ENGINE_IDS.OPENAI), 'shimmer');
  const assignment = store.castAssignments.get('ALICE');
  assert.equal(assignment.voiceId, 'af_bella');
  assert.equal(assignment.voiceIds[ENGINE_IDS.KOKORO], 'af_bella');
  assert.notEqual(assignment.voiceIds[ENGINE_IDS.OPENAI], 'shimmer');
});

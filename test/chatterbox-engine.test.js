import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChatterboxStudioEngine,
  CHATTERBOX_DOWNLOAD_BYTES,
  getChatterboxCacheStatus
} from '../src/audio/chatterbox-engine.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';
import { createVoiceConfigModal } from '../src/ui/voice-config-modal.js';
import { installDom, removeDom } from './dom-helpers.js';

test('Studio Local advertises private non-metered synthesis and bounded chunks', () => {
  const engine = new ChatterboxStudioEngine();
  assert.equal(engine.capabilities.id, ENGINE_IDS.CHATTERBOX);
  assert.equal(engine.capabilities.isLocal, true);
  assert.equal(engine.capabilities.metered, false);
  assert.equal(engine.capabilities.maxChunkChars, 125);
  assert.ok(CHATTERBOX_DOWNLOAD_BYTES > 1_000_000_000);
});

test('Studio Local reports not installed when browser Cache Storage is unavailable', async () => {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  delete globalThis.caches;
  try {
    assert.deepEqual(await getChatterboxCacheStatus(), {
      installed: false,
      fileCount: 0,
      persisted: false
    });
  } finally {
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
  }
});

test('Studio casting requires a private reference before the player can open', () => {
  const dom = installDom();
  try {
    localStorage.removeItem('scriptreader_chatterbox_voice_metadata');
    const scriptStore = {
      currentScript: {
        title: 'Reference Test',
        characters: [{ name: 'ALICE', lineCount: 1, sampleLine: 'Hello.' }],
        elements: [{ type: 'DIALOGUE', character: 'ALICE', text: 'Hello.' }]
      },
      castAssignments: new Map(),
      getNarratorVoice: () => ''
    };
    const audioManager = {
      engineId: ENGINE_IDS.CHATTERBOX,
      capabilities: { supportsInstructions: false },
      getVoiceProfileForCharacter: () => ({ id: '' }),
      stop() {}
    };

    const modal = createVoiceConfigModal({ scriptStore, audioManager, isInitialSetup: true });
    document.body.appendChild(modal);

    assert.ok(modal.querySelector('.studio-voice-library'));
    assert.ok(modal.querySelector('#studio-voice-file'));
    assert.equal(modal.querySelector('#casting-path-recommended').disabled, true);
    assert.equal(modal.querySelector('#btn-modal-save').disabled, true);
  } finally {
    removeDom(dom);
  }
});

test('user-named Studio references are escaped in casting', () => {
  const dom = installDom();
  try {
    localStorage.setItem('scriptreader_chatterbox_voice_metadata', JSON.stringify([{
      id: 'studio-test',
      name: '<img src=x onerror="window.pwned=1">',
      duration: 8,
      createdAt: 1
    }]));
    const assignment = {
      voiceId: 'af_heart',
      voiceIds: { [ENGINE_IDS.CHATTERBOX]: 'studio-test' }
    };
    const scriptStore = {
      currentScript: {
        title: 'Safe References',
        characters: [{ name: 'ALICE', lineCount: 1, sampleLine: 'Hello.' }],
        elements: [{ type: 'DIALOGUE', character: 'ALICE', text: 'Hello.' }]
      },
      castAssignments: new Map([['ALICE', assignment]]),
      getNarratorVoice: () => 'studio-test'
    };
    const audioManager = {
      engineId: ENGINE_IDS.CHATTERBOX,
      capabilities: { supportsInstructions: false },
      getVoiceProfileForCharacter: () => ({ id: 'studio-test' }),
      stop() {}
    };

    const modal = createVoiceConfigModal({ scriptStore, audioManager });
    document.body.appendChild(modal);
    assert.equal(modal.querySelector('img'), null);
    assert.match(modal.textContent, /<img src=x/);
    assert.equal(dom.window.pwned, undefined);
  } finally {
    removeDom(dom);
  }
});

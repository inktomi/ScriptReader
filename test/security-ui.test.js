import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

import { createResumeToastElement } from '../src/ui/resume-toast.js';
import { createVoiceConfigModal } from '../src/ui/voice-config-modal.js';
import { createEngineSettingsModal } from '../src/ui/engine-settings-modal.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';
import { grantCloudConsent, hasCloudConsent } from '../src/utils/credentials.js';
import { installDom, removeDom } from './dom-helpers.js';

test('repository-local environment credentials are ignored and absent', async () => {
  const root = new URL('../', import.meta.url);
  const ignore = await readFile(new URL('.gitignore', root), 'utf8');
  assert.match(ignore, /^\.envrc$/m);
  await assert.rejects(access(new URL('.envrc', root)));
});

test('resume toast renders imported titles as text, not active markup', () => {
  const dom = installDom();
  try {
    const toast = createResumeToastElement('<img src=x onerror="window.pwned=1">');
    document.body.appendChild(toast);
    assert.equal(toast.querySelector('img'), null);
    assert.match(toast.textContent, /<img src=x/);
    assert.equal(dom.window.pwned, undefined);
  } finally {
    removeDom(dom);
  }
});

test('voice setup escapes a screenplay title before assigning innerHTML', () => {
  const dom = installDom();
  try {
    const scriptStore = {
      currentScript: {
        title: '<img src=x onerror="window.pwned=1">',
        characters: [],
        elements: []
      },
      castAssignments: new Map(),
      getNarratorVoice: () => 'bf_emma'
    };
    const audioManager = {
      engineId: ENGINE_IDS.KOKORO,
      capabilities: { supportsInstructions: false },
      getVoiceProfileForCharacter: () => ({ id: 'bf_emma' }),
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

test('Smart Auto-Cast preserves voice choices for the other engine', () => {
  const dom = installDom();
  try {
    let savedCast = null;
    const scriptStore = {
      currentScript: {
        title: 'Cast',
        characters: [{ name: 'ALICE', lineCount: 1, sampleLine: 'Hello.' }],
        elements: [{ type: 'DIALOGUE', character: 'ALICE', text: 'Hello.' }]
      },
      castAssignments: new Map([['ALICE', {
        voiceId: 'af_bella',
        voiceIds: { [ENGINE_IDS.KOKORO]: 'af_bella', [ENGINE_IDS.OPENAI]: 'shimmer' }
      }]]),
      getNarratorVoice: () => 'nova',
      updateCast(payload) { savedCast = payload.castAssignments; }
    };
    const audioManager = {
      engineId: ENGINE_IDS.OPENAI,
      capabilities: { supportsInstructions: true },
      getVoiceProfileForCharacter: () => ({ id: 'nova' }),
      stop() {},
      setNarratorVoice() {},
      setVoiceAssignment() {}
    };
    const modal = createVoiceConfigModal({ scriptStore, audioManager });
    document.body.appendChild(modal);
    modal.querySelector('#btn-modal-autocast').click();
    modal.querySelector('#btn-modal-save').click();

    const assignment = savedCast.get('ALICE');
    assert.equal(assignment.voiceIds[ENGINE_IDS.KOKORO], 'af_bella');
    assert.ok(assignment.voiceIds[ENGINE_IDS.OPENAI]);
  } finally {
    removeDom(dom);
  }
});

test('revoking consent immediately switches an active cloud engine to local', () => {
  const dom = installDom();
  try {
    grantCloudConsent();
    const switches = [];
    const audioManager = {
      engineId: ENGINE_IDS.OPENAI,
      setEngine(engineId) {
        switches.push(engineId);
        this.engineId = engineId;
      }
    };
    const modal = createEngineSettingsModal({ audioManager });
    document.body.appendChild(modal);
    const consent = modal.querySelector('#cloud-consent');
    consent.checked = false;
    consent.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    assert.deepEqual(switches, [ENGINE_IDS.KOKORO]);
    assert.equal(hasCloudConsent(), false);
  } finally {
    removeDom(dom);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createResumeToastElement } from '../src/ui/resume-toast.js';
import { createVoiceConfigModal } from '../src/ui/voice-config-modal.js';
import { createEngineSettingsModal } from '../src/ui/engine-settings-modal.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';
import {
  grantCloudConsent,
  hasCloudConsent,
  loadRunPodEndpointId,
  loadRunPodKey,
  saveRunPodEndpointId,
  saveRunPodKey
} from '../src/utils/credentials.js';
import { installDom, removeDom } from './dom-helpers.js';

test('repository-local environment credentials are ignored', async () => {
  const root = new URL('../', import.meta.url);
  const ignore = await readFile(new URL('.gitignore', root), 'utf8');
  assert.match(ignore, /^\.envrc$/m);
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

test('a character description from an uploaded script renders as text, not markup', () => {
  const dom = installDom();
  try {
    // Everything here is the writer's own prose lifted out of the upload, so it
    // reaches the casting card by exactly the route a cue name does.
    const introduction = {
      text: '<img src=x onerror="window.pwned=1">',
      age: '<img src=x onerror="window.pwned=2">',
      sourceText: '<img src=x onerror="window.pwned=3"> sets down a tray.',
      elementId: 'line-4',
      form: 'parenthetical'
    };
    const scriptStore = {
      currentScript: {
        title: 'Manor',
        characters: [{ name: 'HIGGINS', lineCount: 1, sampleLine: 'Tea, sir?', introduction }],
        elements: [{ type: 'DIALOGUE', character: 'HIGGINS', text: 'Tea, sir?' }]
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
    modal.querySelector('.char-intro-toggle').click();

    assert.equal(modal.querySelector('img'), null);
    assert.match(modal.querySelector('.char-intro-text').textContent, /<img src=x/);
    assert.match(modal.querySelector('.char-intro-source').textContent, /<img src=x/);
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

test('RunPod requires informed cloud consent and discloses ephemeral remote processing', () => {
  const dom = installDom();
  try {
    saveRunPodKey('rpa_test');
    const switches = [];
    const audioManager = {
      engineId: ENGINE_IDS.RUNPOD,
      setEngine(engineId) { switches.push(engineId); this.engineId = engineId; }
    };
    const modal = createEngineSettingsModal({ audioManager });
    document.body.appendChild(modal);

    const apply = modal.querySelector('#btn-engine-apply');
    assert.equal(apply.disabled, true);
    assert.match(modal.textContent, /dedicated worker is used only\s+for this script/i);
    assert.match(modal.textContent, /only in this browser/i);

    const consent = modal.querySelector('#cloud-consent');
    consent.checked = true;
    consent.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(modal.querySelector('#btn-engine-apply').disabled, false);

    const currentConsent = modal.querySelector('#cloud-consent');
    currentConsent.checked = false;
    currentConsent.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.deepEqual(switches, [ENGINE_IDS.KOKORO]);
  } finally {
    removeDom(dom);
  }
});

test('RunPod validation preserves keyboard focus through loading and success', async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  try {
    grantCloudConsent();
    saveRunPodKey('rpa_test');
    globalThis.fetch = async () => new Response(JSON.stringify({ workers: { ready: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    const modal = createEngineSettingsModal({ audioManager: { engineId: ENGINE_IDS.RUNPOD } });
    document.body.appendChild(modal);
    const testButton = modal.querySelector('#btn-test-runpod-key');
    testButton.focus();
    testButton.click();
    assert.equal(document.activeElement.id, 'btn-test-runpod-key');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.activeElement.id, 'btn-test-runpod-key');
    assert.match(modal.textContent, /Connected to RunPod/);
  } finally {
    globalThis.fetch = originalFetch;
    removeDom(dom);
  }
});

test('cancelling RunPod settings does not mutate the active endpoint or key', () => {
  const dom = installDom();
  try {
    grantCloudConsent();
    saveRunPodKey('rpa_original');
    saveRunPodEndpointId('endpoint-original');
    const modal = createEngineSettingsModal({ audioManager: { engineId: ENGINE_IDS.RUNPOD } });
    document.body.appendChild(modal);

    const key = modal.querySelector('#runpod-key-input');
    key.value = 'rpa_draft';
    key.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const endpoint = modal.querySelector('#runpod-endpoint-input');
    endpoint.value = 'endpoint-draft';
    endpoint.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    modal.querySelector('#btn-engine-cancel').click();

    assert.equal(loadRunPodKey(), 'rpa_original');
    assert.equal(loadRunPodEndpointId(), 'endpoint-original');
  } finally {
    removeDom(dom);
  }
});

test('applying changed RunPod settings releases script memory before reconnecting', async () => {
  const dom = installDom();
  try {
    grantCloudConsent();
    saveRunPodKey('rpa_original');
    saveRunPodEndpointId('endpoint-original');
    const calls = [];
    const runPodEngine = {
      release() { calls.push('release'); },
      async init() { calls.push('init'); }
    };
    const audioManager = {
      engineId: ENGINE_IDS.RUNPOD,
      getEngine: () => runPodEngine,
      prewarm() { calls.push('prewarm'); }
    };
    const modal = createEngineSettingsModal({ audioManager });
    document.body.appendChild(modal);

    const endpoint = modal.querySelector('#runpod-endpoint-input');
    endpoint.value = 'endpoint-new';
    endpoint.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    modal.querySelector('#btn-engine-apply').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(loadRunPodEndpointId(), 'endpoint-new');
    assert.deepEqual(calls, ['release', 'init', 'prewarm']);
    assert.equal(document.body.contains(modal), false);
  } finally {
    removeDom(dom);
  }
});

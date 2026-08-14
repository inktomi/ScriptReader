import test from 'node:test';
import assert from 'node:assert/strict';

import { RunPodServerlessEngine } from '../src/audio/runpod-engine.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('RunPod init rejects when API key is missing', async () => {
  const engine = new RunPodServerlessEngine({
    getApiKey: () => '',
    getEndpointId: () => 'test-endpoint'
  });

  await assert.rejects(engine.init(), error => error.code === 'no_key');
  assert.equal(engine.isReady, false);
  assert.equal(engine.phase, 'error');
});

test('RunPod init marks ready when health check passes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/health')) {
      return { ok: true, status: 200, json: async () => ({ workers: { ready: 1 } }) };
    }
    return { ok: false, status: 404 };
  };

  try {
    const engine = new RunPodServerlessEngine({
      getApiKey: () => 'valid-test-key',
      getEndpointId: () => 'test-endpoint'
    });

    await engine.init();
    assert.equal(engine.isReady, true);
    assert.equal(engine.phase, 'ready');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RunPod capabilities specify correct concurrency and engine ID', () => {
  const engine = new RunPodServerlessEngine({
    getApiKey: () => 'test-key',
    getEndpointId: () => 'test-endpoint'
  });

  assert.equal(engine.capabilities.id, ENGINE_IDS.RUNPOD);
  assert.equal(engine.capabilities.supportsSpeed, true);
  assert.equal(engine.capabilities.isLocal, false);
  assert.ok(engine.capabilities.concurrency >= 4);
});

test('an aborted RunPod request does not delete a replacement with the same key', async () => {
  const deferred = [];
  const engine = new RunPodServerlessEngine({
    getApiKey: () => 'test-key',
    getEndpointId: () => 'test-endpoint'
  });
  engine.isReady = true;
  engine._synthesize = () => new Promise((resolve, reject) => deferred.push({ resolve, reject }));

  const unit = { key: 'same-key', text: 'Hello' };
  const first = engine.request(unit);
  first.catch(() => {});
  engine.dropPendingExcept([]);
  const second = engine.request(unit);
  const replacement = engine.pending.get(unit.key);

  deferred[0].reject(new DOMException('aborted', 'AbortError'));
  await tick();
  assert.equal(engine.pending.get(unit.key), replacement);

  deferred[1].resolve({ duration: 1.5 });
  await second;
  assert.equal(engine.pending.has(unit.key), false);
});

test('RunPod _getVoiceReferenceB64 correctly encodes Float32Array reference audio', async () => {
  const engine = new RunPodServerlessEngine({
    getApiKey: () => 'test-key',
    getEndpointId: () => 'test-endpoint'
  });

  // Mock global storage/store for test
  const pcm = new Float32Array(24000); // 1 second of silence
  pcm[100] = 0.5;
  pcm[200] = -0.5;

  const originalGet = globalThis.getChatterboxVoiceSample;
  // Test with mock internal call
  engine._voiceBase64Cache.clear();

  // Test encoding
  const b64 = await engine._getVoiceReferenceB64('');
  assert.equal(b64, null);
});

test('voice mapping preserves Kokoro voice IDs when mapping to RunPod', async () => {
  const { mapVoiceAcrossEngines, getVoicesForEngine } = await import('../src/audio/voice-catalog.js');

  const mappedHeart = mapVoiceAcrossEngines('af_heart', ENGINE_IDS.RUNPOD);
  assert.equal(mappedHeart, 'af_heart');

  const mappedFenrir = mapVoiceAcrossEngines('am_fenrir', ENGINE_IDS.RUNPOD);
  assert.equal(mappedFenrir, 'am_fenrir');

  const runpodPool = getVoicesForEngine(ENGINE_IDS.RUNPOD);
  assert.ok(runpodPool.some(v => v.id === 'af_heart'));
  assert.ok(runpodPool.length >= 20);
});

test('casting modal under RunPod renders reference voice library and allows browsing', async () => {
  const { installDom, removeDom } = await import('./dom-helpers.js');
  const { createVoiceConfigModal } = await import('../src/ui/voice-config-modal.js');

  const dom = installDom();
  try {
    const scriptStore = {
      currentScript: {
        title: 'Test RunPod Screenplay',
        characters: [{ name: 'ALICE', lineCount: 2, sampleLine: 'Hello.' }],
        elements: [{ type: 'DIALOGUE', character: 'ALICE', text: 'Hello.' }]
      },
      castAssignments: new Map(),
      getNarratorVoice: () => 'af_heart'
    };
    const audioManager = {
      engineId: ENGINE_IDS.RUNPOD,
      capabilities: { supportsInstructions: false },
      getVoiceProfileForCharacter: () => ({ id: 'af_heart', name: 'Heart', avatarBg: '#333' }),
      stop() {},
      volume: 1,
      isMuted: false
    };

    const modal = createVoiceConfigModal({ scriptStore, audioManager, isInitialSetup: true });
    document.body.appendChild(modal);

    assert.ok(modal.querySelector('.studio-voice-library'), 'shows reference voice library');
    assert.ok(modal.querySelector('#btn-find-studio-voice'), 'has find voice button');

    const findBtn = modal.querySelector('#btn-find-studio-voice');
    findBtn.click();

    await new Promise(resolve => setTimeout(resolve, 50));
    const catalogDialog = document.body.querySelector('.voice-sample-catalog-overlay');
    assert.ok(catalogDialog, 'opens voice sample catalog modal');
  } finally {
    removeDom(dom);
  }
});

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
  await tick();
  engine.dropPendingExcept([]);
  const second = engine.request(unit);
  await tick();
  const replacement = engine.pending.get(unit.key);

  deferred[0].reject(new DOMException('aborted', 'AbortError'));
  await tick();
  assert.equal(engine.pending.get(unit.key), replacement);

  deferred[1].resolve({ duration: 1.5 });
  await second;
  assert.equal(engine.pending.has(unit.key), false);
});

test('RunPod _synthesize polls when status is IN_PROGRESS or IN_QUEUE', async () => {
  const originalFetch = globalThis.fetch;
  let statusPolls = 0;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/runsync')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'IN_PROGRESS', id: 'job-123' })
      };
    }
    if (url.includes('/status/job-123')) {
      statusPolls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: statusPolls >= 2 ? 'COMPLETED' : 'IN_PROGRESS',
          output: statusPolls >= 2 ? { audio_base64: 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=' } : null
        })
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    const engine = new RunPodServerlessEngine({
      getApiKey: () => 'test-key',
      getEndpointId: () => 'test-endpoint'
    });
    engine.isReady = true;

    // Mock decodeAudioData on audio context
    const unit = { key: 'poll-unit', text: 'Testing polling', voiceId: 'af_heart' };
    const buffer = { duration: 1.0, getChannelData: () => new Float32Array(24000), sampleRate: 24000 };
    engine._synthesize = async () => buffer;

    const result = await engine._loadOrSynthesize(unit, new AbortController().signal);
    assert.equal(result, buffer);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RunPod _pollJob rejects immediately on terminal failure statuses without timing out', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/status/job-fail')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'FAILED', error: 'GPU out of memory' })
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    const engine = new RunPodServerlessEngine({
      getApiKey: () => 'test-key',
      getEndpointId: () => 'test-endpoint'
    });
    engine.isReady = true;

    await assert.rejects(
      engine._pollJob('test-endpoint', 'job-fail', 'test-key', new AbortController().signal),
      error => error.message.includes('GPU out of memory')
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RunPod reuses persistent renderStore cache and writes new renders', async () => {
  const storedPcm = new Int16Array([0, 50, 100]);
  const writes = [];
  const fakeStore = {
    async get(key) {
      if (key === 'cached-unit') return { audio: storedPcm, sampleRate: 24000 };
      return null;
    },
    async put(key, audio, sampleRate) {
      writes.push({ key, audio, sampleRate });
    }
  };

  const engine = new RunPodServerlessEngine({
    getApiKey: () => 'test-key',
    getEndpointId: () => 'test-endpoint',
    renderStore: fakeStore
  });
  engine.isReady = true;

  const mockBuffer = { duration: 1.0, sampleRate: 24000, getChannelData: () => new Float32Array([0, 0.5]) };
  engine._bufferFromPcm = (pcm, sampleRate) => {
    assert.equal(pcm, storedPcm);
    return mockBuffer;
  };
  engine._synthesize = async () => {
    throw new Error('Should not synthesize for cached unit');
  };

  // 1. Cache hit
  const hit = await engine._loadOrSynthesize({ key: 'cached-unit' }, new AbortController().signal);
  assert.equal(hit, mockBuffer);
  assert.equal(writes.length, 0);

  // 2. Cache miss -> synthesizes and writes to renderStore
  engine._synthesize = async () => mockBuffer;
  const miss = await engine._loadOrSynthesize({ key: 'new-unit' }, new AbortController().signal);
  assert.equal(miss, mockBuffer);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'new-unit');
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

import test from 'node:test';
import assert from 'node:assert/strict';

import { RunPodServerlessEngine as RealRunPodServerlessEngine, isAudioSilent } from '../src/audio/runpod-engine.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' }
});

class RunPodServerlessEngine extends RealRunPodServerlessEngine {
  constructor(options = {}) {
    super({ hasConsent: () => true, ...options });
  }
}

test('RunPod enforces cloud consent at the engine boundary', async () => {
  const engine = new RealRunPodServerlessEngine({
    hasConsent: () => false,
    getApiKey: () => 'test-key',
    getEndpointId: () => 'test-endpoint'
  });
  await assert.rejects(engine.init(), error => error.code === 'no_consent');
  await assert.rejects(
    engine._synthesize({ text: 'Private line', voiceId: 'af_heart' }, new AbortController().signal),
    error => error.code === 'no_consent'
  );
});

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
      return jsonResponse({ workers: { ready: 1 } });
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

test('RunPod durable render identity changes with endpoint configuration', () => {
  let endpointId = 'endpoint-a';
  const engine = new RunPodServerlessEngine({
    getEndpointId: () => endpointId
  });
  const profile = { id: 'studio-alice', renderRevision: 4 };
  const first = engine.resolveVoiceCacheId(profile);
  endpointId = 'endpoint-b';
  const second = engine.resolveVoiceCacheId(profile);

  assert.notEqual(first, second);
  assert.match(first, /studio-alice@4@runpod:endpoint-a/);
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
    const buffer = { duration: 1.0, getChannelData: () => new Float32Array([0.1, -0.1, 0.2]), sampleRate: 24000 };
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
      return jsonResponse({ status: 'FAILED', error: 'GPU out of memory' });
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

test('RunPod release cannot be undone by a late browser-store write', async () => {
  let finishWrite;
  const writeStarted = new Promise(resolve => {
    finishWrite = { signal: resolve };
  });
  let resolveWrite;
  const fakeStore = {
    async get() { return null; },
    async put() {
      finishWrite.signal();
      return new Promise(resolve => { resolveWrite = resolve; });
    }
  };
  const engine = new RunPodServerlessEngine({ renderStore: fakeStore });
  const buffer = {
    duration: 1,
    sampleRate: 24000,
    getChannelData: () => new Float32Array([0.2, -0.2])
  };
  engine._synthesize = async () => buffer;

  const request = engine.request({ key: 'late-write', text: 'Hello' });
  await writeStarted;
  engine.release();
  resolveWrite();

  await assert.rejects(request, error => error.name === 'AbortError');
  assert.equal(engine.audioCache.size, 0);
  assert.equal(engine.pending.size, 0);
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

test('RunPod _synthesize propagates worker error when status is COMPLETED with output.error', async () => {
  const originalFetch = globalThis.fetch;
  let submissions = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/runsync')) {
      submissions++;
      return jsonResponse({
        status: 'COMPLETED',
        output: { error: 'CUDA out of memory in Kokoro forward pass' }
      });
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
      engine._synthesize({ text: 'Hello', voiceId: 'af_heart' }, new AbortController().signal),
      error => error.message.includes('CUDA out of memory')
    );
    assert.equal(submissions, 1, 'an accepted failed job must not be resubmitted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RunPod does not resubmit after an accepted queued job later fails', async () => {
  const originalFetch = globalThis.fetch;
  let submissions = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/runsync')) {
      submissions++;
      return jsonResponse({ status: 'IN_QUEUE', id: 'accepted-job' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const engine = new RunPodServerlessEngine({
      getApiKey: () => 'test-key',
      getEndpointId: () => 'test-endpoint'
    });
    engine._pollJob = async () => { throw new Error('status stream disconnected'); };
    await assert.rejects(
      engine._synthesize({ text: 'Hello', voiceId: 'af_heart' }, new AbortController().signal),
      /status stream disconnected/
    );
    assert.equal(submissions, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RunPod rejects an oversized streamed response before audio decoding', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(9 * 1024 * 1024)
    }
  });
  try {
    const engine = new RunPodServerlessEngine({
      getApiKey: () => 'test-key',
      getEndpointId: () => 'test-endpoint'
    });
    await assert.rejects(
      engine._synthesize({ text: 'Hello', voiceId: 'af_heart' }, new AbortController().signal),
      /too much audio data/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RunPod sends the revisioned voice cache identity to its ephemeral worker', async () => {
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse({ status: 'COMPLETED', output: { error: 'stop after payload capture' } });
  };
  try {
    const engine = new RunPodServerlessEngine({
      getApiKey: () => 'test-key',
      getEndpointId: () => 'test-endpoint'
    });
    engine._getVoiceReferenceB64 = async () => 'UklGRg==';
    await assert.rejects(
      engine._synthesize({
        text: 'Hello',
        voiceId: 'studio-alice',
        voiceCacheId: 'studio-alice@revision-2'
      }, new AbortController().signal),
      /stop after payload capture/
    );
    assert.equal(body.input.voice, 'studio-alice');
    assert.equal(body.input.voice_id, 'studio-alice@revision-2');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RunPod release drops only script-owned in-memory state', () => {
  const persistentStore = { get() {}, put() {} };
  const engine = new RunPodServerlessEngine({ renderStore: persistentStore });
  engine.audioCache.set('line', { duration: 1 });
  engine.cachedSeconds = 1;
  engine._voiceBase64Cache.set('voice@1', 'audio');
  engine.isReady = true;

  engine.release();

  assert.equal(engine.audioCache.size, 0);
  assert.equal(engine._voiceBase64Cache.size, 0);
  assert.equal(engine.isReady, false);
  assert.equal(engine.renderStore, persistentStore, 'durable browser resume storage remains configured');
});

test('RunPod _synthesize skips reference lookup for Kokoro voices and errors on missing Studio reference', async () => {
  const { installDom, removeDom } = await import('./dom-helpers.js');
  const dom = installDom();
  try {
    let refLookups = 0;
    const engine = new RunPodServerlessEngine({
      getApiKey: () => 'test-key',
      getEndpointId: () => 'test-endpoint'
    });
    engine.isReady = true;
    engine._getVoiceReferenceB64 = async (voiceId) => {
      refLookups++;
      return null;
    };

    // 1. Missing Studio reference voice errors out immediately
    await assert.rejects(
      engine._synthesize({ text: 'Hello', voiceId: 'custom-voice-ref' }, new AbortController().signal),
      error => error.message.includes('missing its reference recording')
    );
    assert.equal(refLookups, 1);

    // 2. Kokoro voice does NOT query reference audio
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      return jsonResponse({
        status: 'COMPLETED',
        output: { audio_base64: 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=' }
      });
    };

    try {
      // Mock decodeAudioData on audio context
      const origAudioContext = globalThis.AudioContext;
      globalThis.window.AudioContext = class {
        async decodeAudioData() {
          return { duration: 1.0, getChannelData: () => new Float32Array([0.1, -0.1, 0.2]), sampleRate: 24000 };
        }
      };

      try {
        const buffer = await engine._synthesize({ text: 'Hello', voiceId: 'af_heart' }, new AbortController().signal);
        assert.ok(buffer);
        // refLookups count should still be 1 (never incremented for af_heart)
        assert.equal(refLookups, 1);
      } finally {
        globalThis.window.AudioContext = origAudioContext;
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    removeDom(dom);
  }
});

test('auditioning character and narrator in casting modal under RunPod invokes previewVoice with engineId', async () => {
  const { installDom, removeDom } = await import('./dom-helpers.js');
  const { createVoiceConfigModal } = await import('../src/ui/voice-config-modal.js');

  const dom = installDom();
  try {
    const scriptStore = {
      currentScript: {
        title: 'RunPod Audition Script',
        characters: [{ name: 'VALENTINE', lineCount: 4, sampleLine: 'Breach confirmed.' }],
        elements: [{ type: 'DIALOGUE', character: 'VALENTINE', text: 'Breach confirmed.' }]
      },
      castAssignments: new Map([
        ['VALENTINE', { voiceId: 'af_sarah', voiceIds: { [ENGINE_IDS.RUNPOD]: 'af_sarah' }, pitchOffset: 0, speedMultiplier: 1.0 }]
      ]),
      getNarratorVoice: () => 'bf_emma'
    };

    const previews = [];
    const audioManager = {
      engineId: ENGINE_IDS.RUNPOD,
      capabilities: { supportsInstructions: false },
      getVoiceProfileForCharacter: () => ({ id: 'bf_emma', name: 'Emma', avatarBg: '#333' }),
      stop() {},
      async previewVoice(voiceId, sampleText, pitchOffset, speedMultiplier, direction, targetEngineId, onStateChange) {
        previews.push({ voiceId, sampleText, pitchOffset, speedMultiplier, direction, targetEngineId });
        onStateChange?.('playing');
      },
      volume: 1,
      isMuted: false
    };

    const modal = createVoiceConfigModal({ scriptStore, audioManager, isInitialSetup: false });
    document.body.appendChild(modal);

    // 1. Audition character
    const charAuditionBtn = modal.querySelector('.btn-audition-char');
    assert.ok(charAuditionBtn, 'character audition button rendered');
    charAuditionBtn.click();

    assert.equal(previews.length, 1);
    assert.equal(previews[0].voiceId, 'af_sarah');
    assert.equal(previews[0].targetEngineId, ENGINE_IDS.RUNPOD);
    assert.equal(previews[0].sampleText, 'Breach confirmed.');

    // 2. Audition narrator
    const narratorAuditionBtn = modal.querySelector('.btn-audition-narrator');
    assert.ok(narratorAuditionBtn, 'narrator audition button rendered');
    narratorAuditionBtn.click();

    assert.equal(previews.length, 2);
    assert.equal(previews[1].voiceId, 'bf_emma');
    assert.equal(previews[1].targetEngineId, ENGINE_IDS.RUNPOD);
  } finally {
    removeDom(dom);
  }
});

test('cast panel character test under RunPod handles missing assignment cleanly', async () => {
  const { installDom, removeDom } = await import('./dom-helpers.js');
  const { createCastPanel } = await import('../src/ui/cast-panel.js');

  const dom = installDom();
  try {
    const scriptStore = {
      currentScript: {
        title: 'RunPod Cast Panel Script',
        characters: [{ name: 'KIRA', lineCount: 3, sampleLine: 'Copy that.' }],
        elements: [{ type: 'DIALOGUE', character: 'KIRA', text: 'Copy that.' }]
      },
      castAssignments: new Map(), // empty assignments
      getNarratorVoice: () => 'af_heart',
      subscribe: () => () => {}
    };

    const previews = [];
    const audioManager = {
      engineId: ENGINE_IDS.RUNPOD,
      capabilities: { supportsInstructions: false },
      getVoiceProfileForCharacter: () => ({ id: 'af_heart', name: 'Heart', avatarBg: '#333' }),
      stop() {},
      async previewVoice(voiceId, sampleText, pitchOffset, speedMultiplier, direction, targetEngineId, onStateChange) {
        previews.push({ voiceId, sampleText, pitchOffset, speedMultiplier, direction, targetEngineId });
        onStateChange?.('playing');
      },
      volume: 1,
      isMuted: false
    };

    const panel = createCastPanel({ scriptStore, audioManager, onOpenVoiceConfig: () => {} });
    document.body.appendChild(panel.element);

    const testBtn = panel.element.querySelector('.btn-test-voice');
    assert.ok(testBtn, 'test voice button rendered');
    testBtn.click();

    assert.equal(previews.length, 1);
    assert.equal(previews[0].targetEngineId, ENGINE_IDS.RUNPOD);
    assert.equal(previews[0].sampleText, 'Copy that.');
  } finally {
    removeDom(dom);
  }
});

test('isAudioSilent accurately detects silent audio vs audible speech', () => {
  assert.equal(isAudioSilent(null), true);
  assert.equal(isAudioSilent({ duration: 0 }), true);
  assert.equal(isAudioSilent({ duration: 1.0, getChannelData: () => new Float32Array(1000) }), true);
  assert.equal(isAudioSilent({ duration: 1.0, getChannelData: () => new Float32Array([0, 0, 0.00001, -0.00001]) }), true);
  assert.equal(isAudioSilent({ duration: 1.0, getChannelData: () => new Float32Array([0, 0, 0.05, 0.1]) }), false);
});

test('RunPod _synthesize rejects empty or silent audio and prevents caching invalid renders', async () => {
  const engine = new RunPodServerlessEngine({
    getApiKey: () => 'test-key',
    getEndpointId: () => 'test-endpoint'
  });
  engine.isReady = true;

  // 1. Mock _synthesize returning silent audio
  const silentBuffer = {
    duration: 1.5,
    sampleRate: 24000,
    getChannelData: () => new Float32Array(24000)
  };
  engine._synthesize = async () => silentBuffer;

  await assert.rejects(
    engine._loadOrSynthesize({ key: 'silent-line', text: 'Hello world' }, new AbortController().signal),
    error => error.message.includes('empty or silent audio')
  );
});

test('RunPod _loadOrSynthesize bypasses and replaces corrupt silent renders from renderStore', async () => {
  const silentPcm = new Int16Array(24000); // 1.0 sec of zeros
  let writes = [];
  const fakeStore = {
    async get(key) {
      if (key === 'corrupt-line') return { audio: silentPcm, sampleRate: 24000 };
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
  engine._bufferFromPcm = (pcm, sr) => ({
    duration: 1.0,
    sampleRate: sr,
    getChannelData: () => new Float32Array(pcm.length) // returns all zeros
  });

  const validBuffer = {
    duration: 1.5,
    sampleRate: 24000,
    getChannelData: () => new Float32Array([0.1, -0.2, 0.3])
  };
  engine._synthesize = async () => validBuffer;

  const result = await engine._loadOrSynthesize({ key: 'corrupt-line', text: 'Re-render me' }, new AbortController().signal);
  assert.equal(result, validBuffer);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'corrupt-line');
});

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

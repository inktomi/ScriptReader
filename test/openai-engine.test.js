import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAiTtsEngine } from '../src/audio/openai-engine.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('OpenAI init can run again after a later fatal runtime failure', async () => {
  let keyReads = 0;
  const engine = new OpenAiTtsEngine({
    hasConsent: () => true,
    getApiKey: () => {
      keyReads++;
      return 'test-key';
    }
  });

  await engine.init();
  engine.isReady = false;
  await engine.init();
  assert.equal(keyReads, 2);
});

test('revoked consent is enforced by the engine boundary', async () => {
  const engine = new OpenAiTtsEngine({
    hasConsent: () => false,
    getApiKey: () => 'test-key'
  });
  await assert.rejects(engine.init(), error => error.code === 'no_consent');
  assert.equal(engine.isReady, false);
});

test('an aborted request cannot delete a replacement with the same key', async () => {
  const deferred = [];
  const engine = new OpenAiTtsEngine({ hasConsent: () => true, getApiKey: () => 'test-key' });
  engine.isReady = true;
  engine._synthesize = () => new Promise((resolve, reject) => deferred.push({ resolve, reject }));

  const unit = { key: 'same-key' };
  const first = engine.request(unit);
  first.catch(() => {});
  engine.dropPendingExcept([]);
  const second = engine.request(unit);
  const replacement = engine.pending.get(unit.key);

  deferred[0].reject(new DOMException('aborted', 'AbortError'));
  await tick();
  assert.equal(engine.pending.get(unit.key), replacement);

  deferred[1].resolve({ duration: 1 });
  await second;
  assert.equal(engine.pending.has(unit.key), false);
});

test('fatal failures surface errors while isolated render failures are warnings', async () => {
  for (const fatal of [false, true]) {
    const engine = new OpenAiTtsEngine({ hasConsent: () => true, getApiKey: () => 'test-key' });
    engine.isReady = true;
    const phases = [];
    engine.onProgress(payload => phases.push(payload.phase));
    engine._synthesize = async () => {
      const error = new Error(fatal ? 'invalid key' : 'network exhausted');
      error.fatal = fatal;
      throw error;
    };
    await assert.rejects(engine.request({ key: `key-${fatal}` }));
    assert.ok(phases.includes(fatal ? 'error' : 'warning'));
  }
});

test('OpenAI advertises the provider input limit and sends exact numeric speed', async () => {
  const engine = new OpenAiTtsEngine({ hasConsent: () => true, getApiKey: () => 'test-key' });
  let requestBody = null;
  engine._fetchWithRetry = async ({ body }) => {
    requestBody = JSON.parse(body);
    return { arrayBuffer: async () => new ArrayBuffer(2) };
  };

  await assert.rejects(engine._synthesize({
    voiceId: 'marin',
    text: 'Read this precisely.',
    synthSpeed: 1.37,
    instructions: 'Sound urgent.'
  }, new AbortController().signal));

  assert.equal(engine.capabilities.supportsSpeed, true);
  assert.equal(engine.capabilities.maxChunkChars, 4096);
  assert.equal(requestBody.speed, 1.37);
});

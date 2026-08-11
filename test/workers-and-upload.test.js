import test from 'node:test';
import assert from 'node:assert/strict';

import { KokoroNeuralEngine } from '../src/audio/kokoro-engine.js';
import { ModelCacheManager } from '../src/audio/model-cache-manager.js';
import { createUploadModal } from '../src/ui/upload-modal.js';
import { installDom, removeDom } from './dom-helpers.js';

test('a Kokoro worker crash makes the engine unavailable and rejects pending work', async () => {
  const engine = new KokoroNeuralEngine();
  let terminated = false;
  engine.worker = {
    terminate() { terminated = true; },
    onmessage: null,
    onerror: null
  };
  engine.isReady = true;
  const pending = new Promise((resolve, reject) => {
    engine.resolvers.set(1, { resolve, reject });
  });

  engine._handleWorkerCrash({ message: 'boom' });
  await assert.rejects(pending, /boom/);
  assert.equal(engine.isReady, false);
  assert.equal(engine.worker, null);
  assert.equal(terminated, true);
  assert.equal(engine.phase, 'error');
});

test('voice preload fails instead of claiming unsuccessful downloads completed', async () => {
  const originalCaches = globalThis.caches;
  const originalPreloadVoice = ModelCacheManager.preloadVoice;
  globalThis.caches = {
    async open() { return { async keys() { return []; } }; }
  };
  ModelCacheManager.preloadVoice = async () => false;
  try {
    await assert.rejects(ModelCacheManager.preloadAllVoices(), /Could not cache 28 neural voices/);
  } finally {
    ModelCacheManager.preloadVoice = originalPreloadVoice;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('model preload terminates its worker when the worker fails to boot', async () => {
  const OriginalWorker = globalThis.Worker;
  let terminated = false;
  globalThis.Worker = class {
    postMessage() {
      queueMicrotask(() => this.onerror({ message: 'boot failed' }));
    }
    terminate() { terminated = true; }
  };
  try {
    await assert.rejects(
      ModelCacheManager._preloadAllModelAssetsUnlocked(),
      /boot failed/
    );
    assert.equal(terminated, true);
  } finally {
    if (OriginalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = OriginalWorker;
  }
});

test('upload modal ignores a second import while the first is still running', async () => {
  const dom = installDom();
  let resolveImport;
  let calls = 0;
  try {
    const modal = createUploadModal({
      onPdfSelected: () => {
        calls++;
        return new Promise(resolve => { resolveImport = resolve; });
      },
      onFountainTextSubmitted() {}
    });
    document.body.appendChild(modal);
    const input = modal.querySelector('#file-input-pdf');
    const first = new File(['one'], 'first.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { configurable: true, value: [first] });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    const second = new File(['two'], 'second.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { configurable: true, value: [second] });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(calls, 1);
    resolveImport();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    removeDom(dom);
  }
});

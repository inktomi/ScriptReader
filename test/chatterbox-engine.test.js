import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChatterboxStudioEngine,
  CHATTERBOX_DOWNLOAD_BYTES,
  getChatterboxCacheStatus
} from '../src/audio/chatterbox-engine.js';
import { expectedFilesFor } from '../src/audio/chatterbox-model-files.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';
import { createVoiceConfigModal } from '../src/ui/voice-config-modal.js';
import { createEngineSettingsModal } from '../src/ui/engine-settings-modal.js';
import { listChatterboxVoices } from '../src/audio/chatterbox-voice-store.js';
import { decodePcm16, encodePcm16, MAX_RENDER_CACHE_BYTES } from '../src/audio/chatterbox-render-store.js';
import { installDom, removeDom } from './dom-helpers.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
// The modal coalesces progress writes into an animation frame, and with no
// requestAnimationFrame in this environment it falls back to a ~16ms timer.
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 40));

/**
 * A minimal stand-in for the Origin Private File System.
 *
 * `sizes` maps a repo-relative model path to the bytes on disk. Anything absent
 * from it is absent from the cache, which is what lets these tests describe a
 * half-finished install precisely.
 */
function installFakeOpfs(sizes = {}) {
  const files = new Map();
  for (const [path, size] of Object.entries(sizes)) {
    const file = expectedFilesFor('wasm').find(entry => entry.path === path);
    files.set(encodeURIComponent(file ? file.url : path), size);
  }

  const dir = {
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options || !options.create) throw new Error('NotFoundError');
        files.set(name, 0);
      }
      return { async getFile() { return { size: files.get(name) }; } };
    },
    async removeEntry(name) { files.delete(name); }
  };

  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      storage: {
        async getDirectory() {
          return {
            async getDirectoryHandle() { return dir; },
            async removeEntry() { files.clear(); }
          };
        },
        async persisted() { return true; }
      }
    },
    configurable: true,
    writable: true
  });

  return () => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  };
}

const GRAPH_FILES = {
  'onnx/embed_tokens.onnx': 13_286,
  'onnx/speech_encoder.onnx': 1_184_608,
  'onnx/language_model_q4.onnx': 227_911,
  'onnx/conditional_decoder.onnx': 6_350_448
};

const WEIGHT_FILES = {
  'onnx/embed_tokens.onnx_data': 61_640_704,
  'onnx/speech_encoder.onnx_data': 591_274_880,
  'onnx/language_model_q4.onnx_data': 353_621_248,
  'onnx/conditional_decoder.onnx_data': 533_970_816
};

test('Studio Local advertises private non-metered synthesis and bounded chunks', () => {
  const engine = new ChatterboxStudioEngine();
  assert.equal(engine.capabilities.id, ENGINE_IDS.CHATTERBOX);
  assert.equal(engine.capabilities.isLocal, true);
  assert.equal(engine.capabilities.metered, false);
  assert.equal(engine.capabilities.maxChunkChars, 125);
  assert.ok(CHATTERBOX_DOWNLOAD_BYTES > 1_000_000_000);
  assert.ok(MAX_RENDER_CACHE_BYTES < 1024 * 1024 * 1024);
});

test('render cache PCM16 encoding is bounded and preserves the waveform', () => {
  const source = new Float32Array([-1.2, -0.5, 0, 0.5, 1.2]);
  const encoded = encodePcm16(source);
  const decoded = decodePcm16(encoded);

  assert.equal(encoded.byteLength, source.length * 2);
  assert.deepEqual(Array.from(decoded, value => Number(value.toFixed(3))), [-1, -0.5, 0, 0.5, 1]);
});

test('Studio Local reuses a persistent render without synthesizing it again', async () => {
  const stored = { audio: new Int16Array([0, 100]), sampleRate: 24000 };
  const engine = new ChatterboxStudioEngine({
    renderStore: {
      async get(key) { return key === 'cached-line' ? stored : null; },
      async put() { throw new Error('a cache hit must not be rewritten'); }
    }
  });
  const buffer = { duration: 2 };
  engine._bufferFromPcm = (audio, sampleRate) => {
    assert.equal(audio, stored.audio);
    assert.equal(sampleRate, 24000);
    return buffer;
  };
  engine._synthesize = async () => { throw new Error('a cache hit must not synthesize'); };

  assert.equal(await engine._loadOrSynthesize({ key: 'cached-line' }, 0), buffer);
});

test('new Studio renders are durably cached before becoming ready', async () => {
  const writes = [];
  const samples = new Float32Array([0, 0.25]);
  const buffer = { sampleRate: 24000, getChannelData: () => samples };
  const engine = new ChatterboxStudioEngine({
    renderStore: {
      async get() { return null; },
      async put(key, audio, sampleRate) { writes.push({ key, audio, sampleRate }); }
    }
  });
  engine._synthesize = async () => buffer;

  assert.equal(await engine._loadOrSynthesize({ key: 'new-line' }, 0), buffer);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'new-line');
  assert.equal(writes[0].audio, samples);
  assert.equal(writes[0].sampleRate, 24000);
});

test('Studio Local reports not installed when no storage backend can hold the model', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  try {
    assert.deepEqual(await getChatterboxCacheStatus(), {
      installed: false,
      partial: false,
      storable: false,
      device: null,
      weightFiles: { cached: 0, expected: 0 },
      cachedBytes: 0,
      expectedBytes: 0,
      missing: [],
      fileCount: 0,
      persisted: false
    });
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});

// The bug this whole change exists to fix: the small graph files are the only
// ones Chromium's Cache Storage would accept, and the old probe counted four
// `.onnx`-ish keys as a finished install. It then told the user the engine was
// installed while every weight byte was missing.
test('Studio Local is not installed when only the small graph files are present', async () => {
  const restore = installFakeOpfs(GRAPH_FILES);
  try {
    const status = await getChatterboxCacheStatus();
    assert.equal(status.installed, false);
    assert.equal(status.partial, true);
    assert.equal(status.fileCount, 4);
    assert.equal(status.weightFiles.cached, 0);
    assert.equal(status.weightFiles.expected, 4);
    assert.deepEqual(status.missing.sort(), Object.keys(WEIGHT_FILES).sort());
  } finally {
    restore();
  }
});

test('Studio Local is installed once every weight file is on disk at full size', async () => {
  const restore = installFakeOpfs({ ...GRAPH_FILES, ...WEIGHT_FILES });
  try {
    const status = await getChatterboxCacheStatus();
    assert.equal(status.installed, true);
    assert.equal(status.partial, false);
    assert.equal(status.fileCount, 8);
    assert.equal(status.weightFiles.cached, 4);
    assert.deepEqual(status.missing, []);
    assert.equal(status.device, 'wasm');
  } finally {
    restore();
  }
});

test('a truncated weight file does not count as installed', async () => {
  const restore = installFakeOpfs({
    ...GRAPH_FILES,
    ...WEIGHT_FILES,
    'onnx/speech_encoder.onnx_data': 1024
  });
  try {
    const status = await getChatterboxCacheStatus();
    assert.equal(status.installed, false);
    assert.deepEqual(status.missing, ['onnx/speech_encoder.onnx_data']);
  } finally {
    restore();
  }
});

/**
 * transformers.js grows `total` to match `loaded` on every chunk when a response
 * arrived without a Content-Length, so every event it emits claims 100%. The
 * engine has to notice that and fall back to the published file sizes, or the
 * bar pins itself immediately and never moves again — which is exactly what the
 * user saw.
 */
test('progress advances when every event claims loaded === total', () => {
  const engine = new ChatterboxStudioEngine();
  const seen = [];
  engine.onProgress(({ progress }) => seen.push(progress));

  try {
    const file = 'onnx/speech_encoder.onnx_data';
    for (const loaded of [50_000_000, 150_000_000, 300_000_000, 590_000_000]) {
      engine._noteProgress({
        stage: 'download',
        files: [{ file, loaded, total: loaded, status: 'progress' }]
      });
    }

    assert.ok(seen.length >= 4, `expected several updates, saw ${seen.length}`);
    assert.ok(seen[seen.length - 1] > seen[0], 'progress never advanced');
    assert.ok(seen.every((value, i) => i === 0 || value >= seen[i - 1]), 'progress went backwards');
    // Inside the download band throughout, rather than jumping to it and staying.
    assert.ok(seen[0] < 30, `should start low in the band, got ${seen[0]}`);
    assert.ok(seen[seen.length - 1] <= 80, `download band tops out at 80, got ${seen[seen.length - 1]}`);
  } finally {
    engine._clearTimers();
  }
});

test('a trustworthy total is preferred over the published size', () => {
  const engine = new ChatterboxStudioEngine();
  const seen = [];
  engine.onProgress(({ progress }) => seen.push(progress));

  try {
    engine._noteProgress({
      stage: 'download',
      files: [{ file: 'onnx/speech_encoder.onnx_data', loaded: 4_000_000, total: 8_000_000, status: 'progress' }]
    });
    const [first] = seen;
    // Half of a real 8 MB total lands mid-band; half of the 591 MB published
    // size would be a fraction of a percent above the floor.
    assert.ok(first > 40, `expected the reported total to be used, got ${first}`);
  } finally {
    engine._clearTimers();
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
    assert.ok(modal.querySelector('#btn-find-studio-voice'));
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

test('malformed persisted Studio metadata is normalized before casting uses it', () => {
  const dom = installDom();
  try {
    localStorage.setItem('scriptreader_chatterbox_voice_metadata', JSON.stringify([{
      id: 'studio-malformed',
      name: 'Safe fallback',
      tone: { unexpected: true },
      sex: 'provider-specific',
      accent: 42,
      duration: 8
    }]));
    const [voice] = listChatterboxVoices();
    assert.equal(typeof voice.tone, 'string');
    assert.equal(voice.sex, 'Neutral');
    assert.equal(voice.accent, 'Cloned');
    assert.doesNotThrow(() => voice.tone.split(','));
  } finally {
    removeDom(dom);
  }
});

/**
 * The cheapest possible guard against the install hang coming back.
 *
 * The modal used to call render() — a full innerHTML rebuild plus a dozen
 * listener rebinds — on every progress event, of which a 1.4 GB download
 * produces tens of thousands. Node identity is the tell: if the apply button
 * survives a progress event, the modal patched rather than rebuilt.
 */
test('a progress event patches the install bar instead of rebuilding the modal', async () => {
  const dom = installDom();
  try {
    let emit = null;
    const studioEngine = {
      capabilities: { id: ENGINE_IDS.CHATTERBOX },
      onProgress(callback) {
        emit = callback;
        return () => { emit = null; };
      }
    };
    const audioManager = {
      engineId: ENGINE_IDS.CHATTERBOX,
      modelCacheManager: { getStorageEstimate: async () => ({ quota: 0, usage: 0 }) },
      getEngine: () => studioEngine,
      getChatterboxCacheStatus: async () => ({
        installed: false, partial: false, storable: true, persisted: false, fileCount: 0
      }),
      // Never settles: the point is to observe the modal mid-install.
      prepareEngine: () => new Promise(() => {}),
      setEngine() {}
    };

    const modal = createEngineSettingsModal({ audioManager });
    document.body.appendChild(modal);
    await tick();

    modal.querySelector('#btn-engine-apply').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await tick();

    const button = modal.querySelector('#btn-engine-apply');
    const fill = modal.querySelector('.studio-install-fill');
    assert.equal(button.textContent.trim(), 'Installing…');
    assert.ok(emit, 'the modal did not subscribe to engine progress');

    emit({ progress: 42, message: 'Downloading Studio Local: 42% · 600 MB / 1.4 GB', phase: 'loading', stage: 'download' });
    await nextFrame();

    assert.equal(modal.querySelector('#btn-engine-apply'), button, 'the modal was rebuilt');
    assert.equal(modal.querySelector('.studio-install-fill'), fill, 'the progress bar was rebuilt');
    assert.equal(fill.style.width, '42%');
    assert.match(modal.querySelector('.studio-install-text').textContent, /42%/);
    assert.equal(modal.querySelector('.studio-install-bar').getAttribute('aria-valuenow'), '42');
  } finally {
    removeDom(dom);
  }
});

// `||` on a progress value discards a legitimate 0, which is exactly what the
// engine reports when an install fails or is cancelled.
test('a zero-progress error event is not discarded', async () => {
  const dom = installDom();
  try {
    let emit = null;
    const studioEngine = {
      capabilities: { id: ENGINE_IDS.CHATTERBOX },
      onProgress(callback) { emit = callback; return () => { emit = null; }; }
    };
    const audioManager = {
      engineId: ENGINE_IDS.CHATTERBOX,
      modelCacheManager: { getStorageEstimate: async () => ({ quota: 0, usage: 0 }) },
      getEngine: () => studioEngine,
      getChatterboxCacheStatus: async () => ({
        installed: false, partial: false, storable: true, persisted: false, fileCount: 0
      }),
      prepareEngine: () => new Promise(() => {}),
      setEngine() {}
    };

    const modal = createEngineSettingsModal({ audioManager });
    document.body.appendChild(modal);
    await tick();
    modal.querySelector('#btn-engine-apply').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await tick();

    emit({ progress: 60, message: 'Downloading', phase: 'loading', stage: 'download' });
    await nextFrame();
    emit({ progress: 0, message: 'Studio Local stopped responding.', phase: 'error', stage: 'idle' });
    await nextFrame();

    // 2% is the floor the bar renders at, not a retained 60%.
    assert.equal(modal.querySelector('.studio-install-fill').style.width, '2%');
    assert.equal(modal.querySelector('.studio-install-bar').getAttribute('aria-valuenow'), '0');
  } finally {
    removeDom(dom);
  }
});

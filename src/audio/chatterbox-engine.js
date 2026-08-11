import { ENGINE_IDS } from './engine-contract.js';
import { getAudioContext } from './audio-context.js';
import { ModelCacheManager } from './model-cache-manager.js';
import { getChatterboxVoiceSample } from './chatterbox-voice-store.js';

export const CHATTERBOX_MODEL_ID = 'onnx-community/chatterbox-ONNX';
export const CHATTERBOX_DOWNLOAD_BYTES = 1538 * 1024 * 1024;

const MAX_CACHED_SECONDS = 1500;
const EXPECTED_MODEL_SESSIONS = 4;

export async function getChatterboxCacheStatus() {
  if (typeof caches === 'undefined') {
    return { installed: false, fileCount: 0, persisted: false };
  }

  let fileCount = 0;
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    fileCount = keys.filter(request => {
      const url = decodeURIComponent(request.url).toLowerCase();
      return (url.includes('chatterbox-onnx') || url.includes(CHATTERBOX_MODEL_ID.toLowerCase()))
        && url.includes('.onnx');
    }).length;
  } catch (error) {
    console.warn('Studio Local cache status notice:', error);
  }

  return {
    installed: fileCount >= EXPECTED_MODEL_SESSIONS,
    fileCount,
    persisted: await ModelCacheManager.isStoragePersisted()
  };
}

function exaggerationFor(unit) {
  const nuance = unit?.nuance || {};
  const speed = Number(nuance.speedMod || 1);
  const gain = Number(nuance.gainMod || 1);
  if (speed > 1.08 || gain > 1.12) return 0.72;
  if (speed < 0.9 || gain < 0.72) return 0.38;
  return 0.52;
}

export class ChatterboxStudioEngine {
  constructor() {
    this.worker = null;
    this.msgId = 0;
    this.resolvers = new Map();
    this.audioCache = new Map();
    this.cachedSeconds = 0;
    this.pending = new Map();
    this.voiceSamples = new Map();
    this.progressListeners = new Set();
    this.initPromise = null;
    this.isLoading = false;
    this.isReady = false;
    this.isCachedLocally = false;
    this.loadProgress = 0;
    this.statusMessage = 'Not installed';
    this.phase = 'idle';
    this.device = null;
    this.lastError = null;
    this.fileProgress = new Map();
  }

  get capabilities() {
    return {
      id: ENGINE_IDS.CHATTERBOX,
      label: 'Studio Local (Chatterbox)',
      supportsSpeed: false,
      supportsInstructions: false,
      isLocal: true,
      metered: false,
      nativeSampleRate: 24000,
      maxChunkChars: 125,
      concurrency: 1,
      onUnavailable: 'error'
    };
  }

  resolveVoiceId(profile) {
    return profile?.chatterboxId || profile?.id || '';
  }

  onProgress(callback) {
    this.progressListeners.add(callback);
    return () => this.progressListeners.delete(callback);
  }

  notifyProgress(progress, message, phase = 'loading') {
    this.loadProgress = progress;
    this.statusMessage = message;
    this.phase = phase;
    for (const callback of this.progressListeners) {
      callback({ progress, message, phase, isCachedLocally: this.isCachedLocally, error: this.lastError });
    }
  }

  _onWorkerMessage(event) {
    const { type, id, payload, error } = event.data || {};
    if (type === 'progress') {
      this._noteProgress(payload || {});
      return;
    }
    if (!id || !this.resolvers.has(id)) return;
    const resolver = this.resolvers.get(id);
    this.resolvers.delete(id);
    if (type === 'error' || type === 'dropped') resolver.reject(new Error(error || 'Studio voice generation failed.'));
    else resolver.resolve(payload);
  }

  _noteProgress(payload) {
    const file = payload.file || 'model';
    const total = Number(payload.total) || 0;
    const loaded = Number(payload.loaded) || 0;
    if (total > 0) this.fileProgress.set(file, { loaded: Math.min(loaded, total), total });

    let loadedBytes = 0;
    let totalBytes = 0;
    for (const item of this.fileProgress.values()) {
      if (item.total < 1024 * 1024) continue;
      loadedBytes += item.loaded;
      totalBytes += item.total;
    }
    const percent = totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0;
    const overall = totalBytes ? Math.min(98, 8 + Math.round(percent * 0.9)) : 8;
    const verb = this.isCachedLocally ? 'Loading Studio Local' : 'Installing Studio Local';
    const size = totalBytes
      ? ` · ${ModelCacheManager.formatBytes(loadedBytes)} / ${ModelCacheManager.formatBytes(totalBytes)}`
      : '';
    this.notifyProgress(overall, `${verb}: ${percent}%${size}`, 'loading');
  }

  async init(device = 'auto') {
    if (this.isReady) return true;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init(device).finally(() => { this.initPromise = null; });
    return this.initPromise;
  }

  async _init(device) {
    this.isLoading = true;
    this.lastError = null;
    this.fileProgress.clear();
    await ModelCacheManager.requestPersistentStorage();
    const before = await getChatterboxCacheStatus();
    this.isCachedLocally = before.installed;
    this.notifyProgress(
      before.installed ? 18 : 5,
      before.installed ? 'Loading Studio Local from this device…' : 'Preparing the one-time Studio Local download…',
      'loading'
    );

    try {
      this.worker = new Worker(new URL('./chatterbox-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = event => this._onWorkerMessage(event);
      this.worker.onerror = event => {
        const error = new Error(event.message || 'The Studio Local worker stopped unexpectedly.');
        for (const resolver of this.resolvers.values()) resolver.reject(error);
        this.resolvers.clear();
      };

      const result = await new Promise((resolve, reject) => {
        const id = ++this.msgId;
        this.resolvers.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'init', id, payload: { device } });
      });

      const after = await getChatterboxCacheStatus();
      this.device = result?.device || 'wasm';
      this.isCachedLocally = after.installed;
      this.isReady = true;
      this.isLoading = false;
      const acceleration = this.device === 'webgpu' ? 'WebGPU' : 'WASM';
      this.notifyProgress(100, after.installed
        ? `Studio Local is installed and ready offline · ${acceleration}`
        : `Studio Local is ready · ${acceleration}. Browser storage may be cleared under pressure.`, 'ready');
      getAudioContext();
      return true;
    } catch (error) {
      this.isLoading = false;
      this.isReady = false;
      this.lastError = error;
      if (this.worker) this.worker.terminate();
      this.worker = null;
      this.notifyProgress(0, `Studio Local installation failed: ${error.message}`, 'error');
      throw error;
    }
  }

  getCached(key) { return this.audioCache.get(key) || null; }
  has(key) { return this.audioCache.has(key); }
  isPending(key) { return this.pending.has(key); }

  request(unit, priority = 1000) {
    if (!this.isReady || !this.worker) return null;
    if (!unit.voiceId) return Promise.reject(new Error('Assign a reference voice before using Studio Local.'));
    if (this.audioCache.has(unit.key)) return Promise.resolve(this.audioCache.get(unit.key));
    const existing = this.pending.get(unit.key);
    if (existing) {
      if (priority < existing.priority) {
        existing.priority = priority;
        this.worker.postMessage({ type: 'reprioritize', payload: { priorities: { [unit.key]: priority } } });
      }
      return existing.promise;
    }

    const promise = this._synthesize(unit, priority)
      .then(buffer => {
        this.pending.delete(unit.key);
        this._store(unit.key, buffer);
        return buffer;
      })
      .catch(error => {
        this.pending.delete(unit.key);
        this.lastError = error;
        this.notifyProgress(this.loadProgress, error.message, 'warning');
        throw error;
      });
    promise.catch(() => {});
    this.pending.set(unit.key, { promise, priority });
    return promise;
  }

  async _synthesize(unit, priority) {
    let sample = this.voiceSamples.get(unit.voiceId);
    if (!sample) {
      sample = await getChatterboxVoiceSample(unit.voiceId);
      this.voiceSamples.set(unit.voiceId, sample);
    }
    const transferable = sample.slice();
    const raw = await new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.resolvers.set(id, { resolve, reject });
      this.worker.postMessage({
        type: 'generate',
        id,
        payload: {
          key: unit.key,
          text: unit.text,
          voiceId: unit.voiceId,
          audio: transferable.buffer,
          exaggeration: exaggerationFor(unit),
          priority
        }
      }, [transferable.buffer]);
    });

    const context = getAudioContext();
    if (!context) throw new Error('Web Audio is unavailable in this browser.');
    const buffer = context.createBuffer(1, raw.audio.length, raw.sampling_rate || 24000);
    buffer.copyToChannel(raw.audio, 0);
    return buffer;
  }

  _store(key, buffer) {
    if (this.audioCache.has(key)) return;
    this.audioCache.set(key, buffer);
    this.cachedSeconds += buffer.duration;
    while (this.cachedSeconds > MAX_CACHED_SECONDS && this.audioCache.size > 1) {
      const oldestKey = this.audioCache.keys().next().value;
      const oldest = this.audioCache.get(oldestKey);
      this.audioCache.delete(oldestKey);
      this.cachedSeconds -= oldest.duration;
    }
  }

  dropPendingExcept(keepKeys = []) {
    this.worker?.postMessage({ type: 'dropPending', payload: { keepKeys } });
  }

  clearCache() {
    this.audioCache.clear();
    this.cachedSeconds = 0;
  }

  release() {
    const error = new Error('Studio Local was unloaded after switching voice engines.');
    for (const resolver of this.resolvers.values()) resolver.reject(error);
    this.resolvers.clear();
    this.pending.clear();
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.isReady = false;
    this.isLoading = false;
    this.clearCache();
    this.voiceSamples.clear();
    this.phase = 'idle';
    this.statusMessage = this.isCachedLocally ? 'Installed · not loaded' : 'Not loaded';
  }
}

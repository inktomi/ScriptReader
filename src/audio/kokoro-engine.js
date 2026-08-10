import { ModelCacheManager, DEFAULT_MODEL_ID } from './model-cache-manager.js';
import { getAudioContext } from './audio-context.js';

/**
 * Neural synthesis service.
 *
 * This class renders text to AudioBuffers and caches them. It deliberately owns
 * *no* playback: scheduling lives in PlaybackScheduler, so nothing here can ever
 * cancel in-flight lookahead work as a side effect of starting a line.
 */

// Roughly 25 minutes of speech at 24 kHz mono — plenty of runway for a feature
// script while bounding memory on a long sit-back-and-listen session.
const MAX_CACHED_SECONDS = 1500;

export class KokoroNeuralEngine {
  constructor() {
    this.worker = null;
    this.msgId = 0;
    this.resolvers = new Map();

    this.isLoading = false;
    this.isReady = false;
    this.loadProgress = 0;
    this.statusMessage = 'Not loaded';
    this.isCachedLocally = false;
    this.device = null;

    this.audioCache = new Map();      // key -> AudioBuffer (insertion-ordered, LRU-trimmed)
    this.cachedSeconds = 0;
    this.pending = new Map();         // key -> { promise, priority }
    this.progressListeners = new Set();
    this.initPromise = null;
  }

  onProgress(callback) {
    this.progressListeners.add(callback);
    return () => this.progressListeners.delete(callback);
  }

  notifyProgress(progress, message) {
    this.loadProgress = progress;
    this.statusMessage = message;
    for (const cb of this.progressListeners) {
      cb({ progress, message, isCachedLocally: this.isCachedLocally });
    }
  }

  handleWorkerMessage(e) {
    const { type, id, payload, error } = e.data;

    if (type === 'progress') {
      // transformers.js reports progress as a 0-100 percentage, not a fraction.
      const pct = Math.max(0, Math.min(100, payload.progress || 0));
      const base = this.isCachedLocally ? 30 : 20;
      const factor = this.isCachedLocally ? 0.6 : 0.7;
      const overall = Math.min(99, base + Math.round(pct * factor));
      const msg = this.isCachedLocally
        ? `Loading local weights: ${Math.round(pct)}%`
        : `Downloading neural voice weights: ${Math.round(pct)}%`;
      this.notifyProgress(overall, msg);
      return;
    }

    if (id && this.resolvers.has(id)) {
      const { resolve, reject } = this.resolvers.get(id);
      this.resolvers.delete(id);

      if (type === 'error' || type === 'dropped') {
        reject(new Error(error || 'synthesis failed'));
      } else {
        resolve(payload);
      }
    }
  }

  async init(device = 'auto') {
    if (this.isReady) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init(device).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async _init(device) {
    this.isLoading = true;
    this.notifyProgress(5, 'Initializing Kokoro Neural Engine...');

    try {
      await ModelCacheManager.requestPersistentStorage();

      const cacheStatus = await ModelCacheManager.getModelCacheStatus(DEFAULT_MODEL_ID);
      this.isCachedLocally = cacheStatus.isModelCached;

      if (cacheStatus.isModelCached) {
        this.notifyProgress(30, '⚡ Loading Kokoro-82M from local cache...');
      } else {
        this.notifyProgress(15, 'Downloading Kokoro-82M ONNX model weights to local cache...');
      }

      this.worker = new Worker(new URL('./kokoro-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.handleWorkerMessage(e);

      const result = await new Promise((resolve, reject) => {
        const id = ++this.msgId;
        this.resolvers.set(id, { resolve, reject });
        this.worker.postMessage({
          type: 'init',
          id,
          payload: { modelId: DEFAULT_MODEL_ID, device }
        });
      });

      this.device = result && result.device ? result.device : 'wasm';
      this.isReady = true;
      this.isLoading = false;
      this.isCachedLocally = true;

      const accel = this.device === 'webgpu' ? ' (WebGPU accelerated)' : '';
      this.notifyProgress(100, cacheStatus.isModelCached
        ? `⚡ Kokoro Neural Engine ready${accel}`
        : `Kokoro Neural Engine ready & cached locally${accel}`);

      getAudioContext();

      ModelCacheManager.preloadAllVoices(DEFAULT_MODEL_ID).catch(err => {
        console.warn('Voice pre-caching notice:', err);
      });

      return true;
    } catch (error) {
      console.warn('Kokoro neural engine initialization failed:', error);
      this.isLoading = false;
      this.isReady = false;
      this.notifyProgress(0, `Neural engine load failed: ${error.message || 'Offline fallback ready'}`);
      throw error;
    }
  }

  getCached(key) {
    return this.audioCache.get(key) || null;
  }

  has(key) {
    return this.audioCache.has(key);
  }

  isPending(key) {
    return this.pending.has(key);
  }

  /**
   * Queue a unit for synthesis. Safe to call every tick: already-cached units are
   * no-ops and already-queued units only get their priority raised.
   *
   * `priority` is a small integer — 0 is "needed next", higher is further ahead.
   */
  request(unit, priority = 1000) {
    if (!this.isReady || !this.worker) return null;
    if (this.audioCache.has(unit.key)) return Promise.resolve(this.audioCache.get(unit.key));

    const existing = this.pending.get(unit.key);
    if (existing) {
      if (priority < existing.priority) {
        existing.priority = priority;
        this.worker.postMessage({
          type: 'reprioritize',
          payload: { priorities: { [unit.key]: priority } }
        });
      }
      return existing.promise;
    }

    const promise = this._synthesize(unit, priority)
      .then((buffer) => {
        this.pending.delete(unit.key);
        this._store(unit.key, buffer);
        return buffer;
      })
      .catch((err) => {
        this.pending.delete(unit.key);
        throw err;
      });

    // Lookahead rejections are expected (dropped on seek) and must not surface
    // as unhandled rejections; callers that care attach their own handler.
    promise.catch(() => {});

    this.pending.set(unit.key, { promise, priority });
    return promise;
  }

  async _synthesize(unit, priority) {
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
          speed: unit.kokoroSpeed,
          priority
        }
      });
    });

    const ctx = getAudioContext();
    if (!ctx) throw new Error('Web Audio is unavailable in this browser.');

    const sampleRate = raw.sampling_rate || 24000;
    const buffer = ctx.createBuffer(1, raw.audio.length, sampleRate);
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

  /**
   * Abandon queued lookahead that a seek made irrelevant. Units listed in
   * `keepKeys` survive; anything already generating still completes and caches.
   */
  dropPendingExcept(keepKeys = []) {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'dropPending', payload: { keepKeys } });
  }

  clearCache() {
    this.audioCache.clear();
    this.cachedSeconds = 0;
  }
}

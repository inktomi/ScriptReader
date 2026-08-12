import { ModelCacheManager, DEFAULT_MODEL_ID } from './model-cache-manager.js';
import { getAudioContext } from './audio-context.js';
import { ENGINE_IDS } from './engine-contract.js';
import { KokoroDownloadProgress } from './kokoro-model-files.js';

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

// The weights are hundreds of megabytes, so a slow link can legitimately go a
// long time between chunks. Say something after this much silence rather than
// leaving a bar that looks identical to a hung request.
const STALL_HINT_MS = 30000;

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

    // 'idle' | 'loading' | 'ready' | 'error' — subscribers branch on this rather
    // than inferring from isLoading/isReady, which are *both* false on failure
    // and so leave any two-branch consumer showing a stale message forever.
    this.phase = 'idle';
    this.lastError = null;

    // Aggregate bytes across every file being fetched, so the reported
    // percentage is not whichever file happens to be streaming right now.
    this.download = new KokoroDownloadProgress();
    this._loadingBaseMessage = '';
    this._maxProgress = 0;
    this._lastEmitted = null;
    this._stallTimer = null;

    this.audioCache = new Map();      // key -> AudioBuffer (insertion-ordered, LRU-trimmed)
    this.cachedSeconds = 0;
    this.pending = new Map();         // key -> { promise, priority }
    this.progressListeners = new Set();
    this.initPromise = null;
  }

  get capabilities() {
    return {
      id: ENGINE_IDS.KOKORO,
      label: 'Kokoro 82M (local)',
      // `speed` moves tempo while preserving pitch, which is what makes the
      // tempo/pitch cancellation in the director possible.
      supportsSpeed: true,
      supportsInstructions: false,
      isLocal: true,
      metered: false,
      nativeSampleRate: 24000,
      // Small, so playback can start before a long speech has finished rendering
      // and so no single request approaches the model's token ceiling.
      maxChunkChars: 190,
      // One ONNX session, one inference at a time.
      concurrency: 1,
      // A failed local download is exactly the case the browser's built-in voice
      // exists to cover.
      onUnavailable: 'webspeech'
    };
  }

  resolveVoiceId(voiceProfile) {
    return (voiceProfile && (voiceProfile.kokoroId || voiceProfile.id)) || 'af_heart';
  }

  onProgress(callback) {
    this.progressListeners.add(callback);
    return () => this.progressListeners.delete(callback);
  }

  notifyProgress(progress, message, phase = 'loading') {
    this.phase = phase;
    this.loadProgress = progress;
    this.statusMessage = message;
    for (const cb of this.progressListeners) {
      cb({ progress, message, phase, isCachedLocally: this.isCachedLocally, error: this.lastError });
    }
  }

  /**
   * Emit a loading update, ratcheted and de-duplicated.
   *
   * The ratchet is not cosmetic. The denominator legitimately changes mid-flight
   * — when a file's total becomes trustworthy, and when a WebGPU attempt fails
   * and the WASM retry swaps a 155 MB fp16 weights file for a 88 MB q8 one — and
   * without this the bar would visibly walk backwards.
   */
  _emitLoading(progress, message) {
    const next = Math.max(this._maxProgress, Math.min(99, Math.round(progress)));
    this._maxProgress = next;
    if (this._lastEmitted && this._lastEmitted.progress === next && this._lastEmitted.message === message) {
      return;
    }
    this._lastEmitted = { progress: next, message };
    this.notifyProgress(next, message, 'loading');
  }

  /** Fold one transformers.js progress event in, then redraw from the total. */
  _noteDownloadProgress(payload) {
    this._armStallWatchdog();
    this.download.note(payload || {});
    this._publishDownloadProgress();
  }

  _publishDownloadProgress() {
    const { loaded, total } = this.download.totals();
    const base = this.isCachedLocally ? 30 : 20;

    if (total === 0) {
      // Nothing but the small metadata files so far.
      this._loadingBaseMessage = 'Fetching model metadata...';
      this._emitLoading(base, this._loadingBaseMessage);
      return;
    }

    const pct = Math.max(0, Math.min(100, (loaded / total) * 100));
    const factor = this.isCachedLocally ? 0.6 : 0.7;

    const verb = this.isCachedLocally ? 'Loading local weights' : 'Downloading neural voice weights';
    const size = `${ModelCacheManager.formatBytes(loaded)} / ${ModelCacheManager.formatBytes(total)}`;

    this._loadingBaseMessage = `${verb}: ${Math.round(pct)}% — ${size}`;
    this._emitLoading(base + pct * factor, this._loadingBaseMessage);
  }

  _armStallWatchdog() {
    this._clearStallWatchdog();
    this._stallTimer = setTimeout(() => {
      if (this.phase !== 'loading') return;
      const base = this._loadingBaseMessage || this.statusMessage;
      const seconds = Math.round(STALL_HINT_MS / 1000);
      this.notifyProgress(
        this.loadProgress,
        `${base} — still waiting on the network (no data for ${seconds}s)`,
        'loading'
      );
      // The hint went out around `_emitLoading`, so forget what was last
      // emitted: otherwise the resuming chunk could be deduplicated against the
      // pre-hint message and leave "still waiting" on screen after data
      // returned.
      this._lastEmitted = null;
      // Re-arm so the hint survives; the suffix is rebuilt from the stored base
      // each time rather than appended, so it never compounds.
      this._armStallWatchdog();
    }, STALL_HINT_MS);
  }

  _clearStallWatchdog() {
    if (this._stallTimer) {
      clearTimeout(this._stallTimer);
      this._stallTimer = null;
    }
  }

  handleWorkerMessage(e) {
    const { type, id, payload, error } = e.data;

    if (type === 'progress') {
      this._noteDownloadProgress(payload);
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

  _handleWorkerCrash(err) {
    const error = new Error((err && err.message) || 'Neural worker stopped unexpectedly');
    const pending = [...this.resolvers.values()];
    this.resolvers.clear();
    for (const { reject } of pending) reject(error);

    this.isLoading = false;
    this.isReady = false;
    this.lastError = error;
    this._clearStallWatchdog();

    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.notifyProgress(0, `Neural engine failed: ${error.message}`, 'error');
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
    this.lastError = null;
    // A retry must not inherit byte totals — or a high-water mark — from the
    // attempt that failed.
    this.download.reset();
    this._loadingBaseMessage = '';
    this._maxProgress = 0;
    this._lastEmitted = null;
    this._emitLoading(5, 'Initializing Kokoro Neural Engine...');

    try {
      await ModelCacheManager.requestPersistentStorage();

      const cacheStatus = await ModelCacheManager.getModelCacheStatus(DEFAULT_MODEL_ID);
      this.isCachedLocally = cacheStatus.isModelCached;

      this._loadingBaseMessage = cacheStatus.isModelCached
        ? '⚡ Loading Kokoro-82M from local cache...'
        : 'Downloading Kokoro-82M ONNX model weights to local cache...';
      this._emitLoading(cacheStatus.isModelCached ? 30 : 15, this._loadingBaseMessage);
      this._armStallWatchdog();

      this.worker = new Worker(new URL('./kokoro-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.handleWorkerMessage(e);
      // A worker that fails to boot (bad import, blocked module fetch) otherwise
      // leaves the init promise pending forever with nothing on screen to say so.
      this.worker.onerror = (err) => this._handleWorkerCrash(err);

      const result = await new Promise((resolve, reject) => {
        const id = ++this.msgId;
        this.resolvers.set(id, { resolve, reject });
        this.worker.postMessage({
          type: 'init',
          id,
          payload: { modelId: DEFAULT_MODEL_ID, device }
        });
      });

      this._clearStallWatchdog();
      this.device = result && result.device ? result.device : 'wasm';
      this.isReady = true;
      this.isLoading = false;

      // Re-read the cache instead of assuming the weights landed. Cache Storage
      // rejects put() for very large bodies with an opaque internal error well
      // before the quota is reached (~200 MB+ in Chromium), and transformers.js
      // only console.warns about it — so a "cached locally" claim here can be
      // flatly untrue and the next visit re-downloads everything.
      const postStatus = await ModelCacheManager.getModelCacheStatus(DEFAULT_MODEL_ID);
      this.isCachedLocally = postStatus.isModelCached;

      const accel = this.device === 'webgpu' ? ' (WebGPU accelerated)' : '';
      this.notifyProgress(100, postStatus.isModelCached
        ? `⚡ Kokoro Neural Engine ready & cached locally${accel}`
        : `Kokoro Neural Engine ready${accel} — weights too large to cache, will re-download`, 'ready');

      getAudioContext();

      ModelCacheManager.preloadAllVoices(DEFAULT_MODEL_ID).catch(err => {
        console.warn('Voice pre-caching notice:', err);
      });

      return true;
    } catch (error) {
      console.warn('Kokoro neural engine initialization failed:', error);
      this._clearStallWatchdog();
      this.isLoading = false;
      this.isReady = false;
      this.lastError = error;

      // Tear the failed worker down. init() is retryable, and without this every
      // retry would strand another module worker holding an ORT session.
      if (this.worker) {
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.worker.terminate();
        this.worker = null;
      }
      this.resolvers.clear();

      this.notifyProgress(0, `Neural engine load failed: ${error.message || 'Unknown error'}`, 'error');
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
          speed: unit.synthSpeed,
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

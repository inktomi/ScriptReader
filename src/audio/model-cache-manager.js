/**
 * Model Cache Manager for ScriptReader Pro
 * Ensures all models (Kokoro-82M ONNX weights, tokenizer, configs) and all 28 neural voice embeddings
 * are cached locally in persistent browser CacheStorage on first load so they load instantaneously on subsequent visits.
 */

export const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
export const KOKORO_VOICES_CACHE_NAME = 'kokoro-voices';
export const DEFAULT_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export const ALL_KOKORO_VOICE_IDS = [
  // Female Voices
  'af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'af_river',
  'bf_emma', 'bf_isabella', 'bf_lily', 'af_alloy', 'af_aoede', 'af_jessica',
  'af_kore', 'af_nova', 'bf_alice',
  // Male Voices
  'am_adam', 'am_onyx', 'am_fenrir', 'am_echo', 'am_liam', 'am_michael',
  'am_puck', 'am_santa', 'bm_george', 'bm_lewis', 'bm_fable', 'bm_daniel',
  'am_eric'
];

export class ModelCacheManager {
  static _cacheOperation = Promise.resolve();

  static _withCacheLock(operation) {
    const next = this._cacheOperation.then(operation, operation);
    this._cacheOperation = next.catch(() => {});
    return next;
  }
  /**
   * Request persistent storage from the browser so cached models are never evicted
   */
  static async requestPersistentStorage() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      try {
        const isPersisted = await navigator.storage.persist();
        return isPersisted;
      } catch (err) {
        console.warn('Storage persist request notice:', err);
        return false;
      }
    }
    return false;
  }

  /**
   * Check if storage is currently persistent
   */
  static async isStoragePersisted() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persisted) {
      try {
        return await navigator.storage.persisted();
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  /**
   * Format bytes to human-readable string
   */
  static formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Query estimated storage quota and usage
   */
  static async getStorageEstimate() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const persisted = await this.isStoragePersisted();
        return {
          usage: estimate.usage || 0,
          quota: estimate.quota || 0,
          usageFormatted: this.formatBytes(estimate.usage || 0),
          quotaFormatted: this.formatBytes(estimate.quota || 0),
          persisted
        };
      } catch (e) {
        console.warn('Storage estimate notice:', e);
      }
    }
    return {
      usage: 0,
      quota: 0,
      usageFormatted: '0 MB',
      quotaFormatted: 'Unknown',
      persisted: false
    };
  }

  /**
   * Check if Kokoro ONNX model and voices are cached locally
   */
  static async getModelCacheStatus(modelId = DEFAULT_MODEL_ID) {
    let isModelCached = false;
    let cachedModelFiles = 0;
    let cachedVoiceCount = 0;
    let totalCachedBytes = 0;

    if (typeof caches === 'undefined') {
      return {
        isModelCached: false,
        cachedModelFiles: 0,
        cachedVoiceCount: 0,
        totalVoices: ALL_KOKORO_VOICE_IDS.length,
        totalCachedBytes: 0,
        formattedSize: '0 MB',
        isFullyCached: false,
        isStoragePersisted: false,
        offlineReady: false
      };
    }

    try {
      // 1. Check Transformers.js cache for model files
      const tfCache = await caches.open(TRANSFORMERS_CACHE_NAME);
      const tfKeys = await tfCache.keys();
      
      // Only an actual weights blob counts. config.json + tokenizer.json are a
      // few KB and land first, so treating them as evidence made an interrupted
      // download report "cached" on the next visit — and the UI then claimed it
      // was loading locally while re-pulling hundreds of megabytes.
      const MIN_WEIGHTS_BYTES = 1024 * 1024;
      let hasWeights = false;

      for (const req of tfKeys) {
        const url = req.url;
        if (url.includes(modelId) || url.includes('Kokoro-82M')) {
          cachedModelFiles++;
          let entryBytes = 0;
          try {
            const resp = await tfCache.match(req);
            if (resp) {
              const cl = resp.headers.get('content-length');
              if (cl) {
                entryBytes = parseInt(cl, 10) || 0;
              } else {
                // .blob() rather than .arrayBuffer(): the weights entry can be
                // 300 MB+, and a Blob stays backed by the browser's blob store
                // instead of being copied onto the JS heap just to read .size.
                const blob = await resp.clone().blob();
                entryBytes = blob.size;
              }
              totalCachedBytes += entryBytes;
            }
          } catch (e) {
            // ignore sizing error
          }
          if (url.includes('.onnx') && entryBytes >= MIN_WEIGHTS_BYTES) {
            hasWeights = true;
          }
        }
      }

      isModelCached = hasWeights;

      // 2. Check Kokoro Voices cache
      const voiceCache = await caches.open(KOKORO_VOICES_CACHE_NAME);
      const voiceKeys = await voiceCache.keys();
      const cachedVoiceUrls = new Set(voiceKeys.map(k => k.url));

      for (const voiceId of ALL_KOKORO_VOICE_IDS) {
        const expectedUrl = `https://huggingface.co/${modelId}/resolve/main/voices/${voiceId}.bin`;
        if (cachedVoiceUrls.has(expectedUrl)) {
          cachedVoiceCount++;
          try {
            const resp = await voiceCache.match(expectedUrl);
            if (resp) {
              const cl = resp.headers.get('content-length');
              if (cl) {
                totalCachedBytes += parseInt(cl, 10);
              } else {
                totalCachedBytes += 102400; // approx ~100KB per voice
              }
            }
          } catch (e) {}
        }
      }

    } catch (err) {
      console.warn('Error querying model cache status:', err);
    }

    const isFullyCached = isModelCached && cachedVoiceCount >= ALL_KOKORO_VOICE_IDS.length;
    const isStoragePersisted = await this.isStoragePersisted();

    return {
      isModelCached,
      cachedModelFiles,
      cachedVoiceCount,
      totalVoices: ALL_KOKORO_VOICE_IDS.length,
      totalCachedBytes,
      formattedSize: this.formatBytes(totalCachedBytes),
      isFullyCached,
      isStoragePersisted,
      offlineReady: isModelCached
    };
  }

  /**
   * Preload and cache a single voice .bin file into kokoro-voices CacheStorage
   */
  static async preloadVoice(voiceId, modelId = DEFAULT_MODEL_ID) {
    if (typeof caches === 'undefined') return false;

    const voiceUrl = `https://huggingface.co/${modelId}/resolve/main/voices/${voiceId}.bin`;
    try {
      const cache = await caches.open(KOKORO_VOICES_CACHE_NAME);
      const existing = await cache.match(voiceUrl);
      if (existing) {
        return true; // already cached
      }

      // no-referrer: huggingface.co drops Access-Control-Allow-Origin when a
      // request carries a Referer from some hosts (see public/_headers), which
      // turns every voice fetch into an opaque CORS failure. The header covers
      // this too; setting it here as well keeps the app working if it is ever
      // served from somewhere that does not apply _headers.
      const response = await fetch(voiceUrl, { referrerPolicy: 'no-referrer' });
      if (response.ok) {
        const clone = response.clone();
        await cache.put(voiceUrl, clone);
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`Failed to preload voice ${voiceId}:`, err);
      return false;
    }
  }

  /**
   * Preload and cache all 28 Kokoro voice files in the background with progress reporting
   */
  static async preloadAllVoices(modelId = DEFAULT_MODEL_ID, onProgress = () => {}) {
    return this._withCacheLock(() => this._preloadAllVoicesUnlocked(modelId, onProgress));
  }

  static async _preloadAllVoicesUnlocked(modelId = DEFAULT_MODEL_ID, onProgress = () => {}) {
    if (typeof caches === 'undefined') return;

    let completed = 0;
    const total = ALL_KOKORO_VOICE_IDS.length;

    // Check which ones are already cached
    const cache = await caches.open(KOKORO_VOICES_CACHE_NAME);
    const existingKeys = new Set((await cache.keys()).map(k => k.url));

    const toFetch = ALL_KOKORO_VOICE_IDS.filter(id => {
      const url = `https://huggingface.co/${modelId}/resolve/main/voices/${id}.bin`;
      if (existingKeys.has(url)) {
        completed++;
        return false;
      }
      return true;
    });

    onProgress({
      phase: 'voices',
      completed,
      total,
      percent: Math.round((completed / total) * 100),
      message: `Cached ${completed}/${total} neural voices...`
    });

    if (toFetch.length === 0) {
      return;
    }

    // Download remaining voices with a concurrency of 4
    const concurrency = 4;
    const queue = [...toFetch];
    const failed = [];

    const worker = async () => {
      while (queue.length > 0) {
        const voiceId = queue.shift();
        if (!voiceId) break;
        const succeeded = await this.preloadVoice(voiceId, modelId);
        if (succeeded) completed++;
        else failed.push(voiceId);
        onProgress({
          phase: 'voices',
          completed,
          total,
          percent: Math.round((completed / total) * 100),
          message: succeeded
            ? `Caching neural voice: ${voiceId} (${completed}/${total})`
            : `Could not cache neural voice: ${voiceId}`
        });
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, toFetch.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (failed.length > 0) {
      throw new Error(`Could not cache ${failed.length} neural voice${failed.length === 1 ? '' : 's'}.`);
    }

    onProgress({
      phase: 'voices',
      completed: total,
      total,
      percent: 100,
      message: `All ${total} neural character voices cached locally!`
    });
  }

  /**
   * Proactively preload and cache ALL model assets (ONNX model weights, tokenizer, and 28 voices)
   */
  static async preloadAllModelAssets(modelId = DEFAULT_MODEL_ID, onProgress = () => {}) {
    return this._withCacheLock(() => this._preloadAllModelAssetsUnlocked(modelId, onProgress));
  }

  static async _preloadAllModelAssetsUnlocked(modelId = DEFAULT_MODEL_ID, onProgress = () => {}) {
    await this.requestPersistentStorage();

    onProgress({
      phase: 'init',
      percent: 5,
      message: 'Initializing local model cache...'
    });

    // 1. Load KokoroTTS model via worker (this triggers @huggingface/transformers to download and cache config, tokenizer, onnx)
    const worker = new Worker(new URL('./kokoro-worker.js', import.meta.url), { type: 'module' });
    
    try {
      await new Promise((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message || 'Model worker failed to start'));
        worker.onmessageerror = () => reject(new Error('Model worker sent an unreadable response'));
        worker.onmessage = (e) => {
          const { type, payload, error } = e.data;
          if (type === 'progress') {
            const p = payload;
            const modelPct = 15 + Math.round(p.progress * 0.65); // 15% -> 80%
            onProgress({
              phase: 'model',
              percent: modelPct,
              file: p.file || 'weights',
              loaded: p.loaded,
              total: p.total,
              // p.progress is already 0-100; scaling it again rendered "10000%".
              message: `Caching model weights: ${Math.round(p.progress)}%`
            });
          } else if (type === 'init_complete') {
            resolve();
          } else if (type === 'error') {
            reject(new Error(error));
          }
        };

        worker.postMessage({
          type: 'init',
          id: 1,
          payload: { modelId, device: 'auto' }
        });
      });
    } finally {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }

    // 2. Preload all 28 voices
    onProgress({
      phase: 'voices',
      percent: 80,
      message: 'Caching all 28 character voice embeddings...'
    });

    await this._preloadAllVoicesUnlocked(modelId, (vProg) => {
      // * 20, not * 0.2 — the latter rounded to 0 and pinned this at a flat 80%.
      const overall = 80 + Math.round((vProg.completed / vProg.total) * 20); // 80% -> 100%
      onProgress({
        phase: 'voices',
        percent: overall,
        completed: vProg.completed,
        total: vProg.total,
        message: vProg.message
      });
    });

    onProgress({
      phase: 'complete',
      percent: 100,
      message: 'Kokoro-82M model and all 28 voices fully cached locally!'
    });

    const status = await this.getModelCacheStatus(modelId);
    if (!status.isFullyCached) {
      throw new Error(
        status.cachedVoiceCount < status.totalVoices
          ? `Only ${status.cachedVoiceCount}/${status.totalVoices} neural voices were cached.`
          : 'The model weights could not be retained in browser cache storage.'
      );
    }
    return status;
  }

  /**
   * Delete cached model weights and voice files from CacheStorage
   */
  static async clearModelCache(modelId = DEFAULT_MODEL_ID) {
    return this._withCacheLock(() => this._clearModelCacheUnlocked(modelId));
  }

  static async _clearModelCacheUnlocked(modelId = DEFAULT_MODEL_ID) {
    if (typeof caches === 'undefined') return false;

    try {
      // 1. Delete matching entries in transformers-cache
      const tfCache = await caches.open(TRANSFORMERS_CACHE_NAME);
      const tfKeys = await tfCache.keys();
      for (const req of tfKeys) {
        if (req.url.includes(modelId) || req.url.includes('Kokoro-82M')) {
          await tfCache.delete(req);
        }
      }

      // 2. Delete kokoro-voices cache
      await caches.delete(KOKORO_VOICES_CACHE_NAME);
      return true;
    } catch (err) {
      console.warn('Error clearing model cache:', err);
      return false;
    }
  }
}

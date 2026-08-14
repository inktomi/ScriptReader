import { readBoundedResponseJson } from '../utils/bounded-response.js';
import { DEFAULT_RUNPOD_ENDPOINT, hasCloudConsent, loadRunPodEndpointId, loadRunPodKey } from '../utils/credentials.js';
import { getAudioContext } from './audio-context.js';
import { chatterboxRenderStore, decodePcm16 } from './chatterbox-render-store.js';
import { getChatterboxVoiceSample } from './chatterbox-voice-store.js';
import { ENGINE_IDS } from './engine-contract.js';

const MAX_CACHED_SECONDS = 1500;
const CONCURRENCY = 6;
const MAX_ATTEMPTS = 3;
const RETRYABLE_SUBMISSION_STATUS = new Set([429]);
const RETRYABLE_POLL_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RUNPOD_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BASE64_CHARS = 6 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 60;
const MAX_REFERENCE_CACHE_ENTRIES = 32;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function float32ToWavBase64(pcmFloat32, sampleRate = 24000) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmFloat32.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  // fmt chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // 16-bit
  // data chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcmFloat32.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function isAudioSilent(buffer) {
  if (!buffer || (buffer.duration !== undefined && buffer.duration <= 0)) return true;
  const channelData =
    typeof buffer.getChannelData === 'function' ? buffer.getChannelData(0) : buffer.channelData?.[0] || null;
  if (!channelData) {
    return (
      (buffer.duration !== undefined && buffer.duration <= 0) || (buffer.length !== undefined && buffer.length <= 0)
    );
  }
  if (channelData.length === 0) return true;
  for (let i = 0; i < channelData.length; i++) {
    if (Math.abs(channelData[i]) > 0.0001) return false;
  }
  return true;
}

export class RunPodServerlessEngine {
  constructor({
    getApiKey = loadRunPodKey,
    getEndpointId = loadRunPodEndpointId,
    hasConsent = hasCloudConsent,
    renderStore = chatterboxRenderStore,
  } = {}) {
    this.getApiKey = getApiKey;
    this.getEndpointId = getEndpointId;
    this.hasConsent = hasConsent;
    this.renderStore = renderStore;

    this.isReady = false;
    this.isLoading = false;
    this.phase = 'idle';
    this.statusMessage = 'Not connected';

    this.audioCache = new Map();
    this.cachedSeconds = 0;
    this.pending = new Map(); // key -> { promise, controller, priority }
    this.activeWorkers = 0;
    this.queue = []; // Array<{ unit, priority, resolve, reject, controller }>
    this.progressListeners = new Set();
    this._voiceBase64Cache = new Map();
    this.generation = 0;
  }

  get capabilities() {
    return {
      id: ENGINE_IDS.RUNPOD,
      label: 'RunPod GPU (Cloud L40S)',
      supportsSpeed: true,
      supportsInstructions: false,
      isLocal: false,
      // RunPod intentionally renders the complete active script after the user
      // grants cloud consent. Billing is bounded by that script-scoped render,
      // not by waiting for individual Play presses.
      metered: false,
      nativeSampleRate: 24000,
      maxChunkChars: 350,
      concurrency: CONCURRENCY,
      onUnavailable: 'error',
    };
  }

  resolveVoiceId(voiceProfile) {
    return voiceProfile?.chatterboxId || voiceProfile?.id || voiceProfile?.kokoroId || 'af_heart';
  }

  resolveVoiceCacheId(profile) {
    const id = this.resolveVoiceId(profile);
    const revision = profile?.renderRevision || 'v2';
    const endpointId = this.getEndpointId().trim() || DEFAULT_RUNPOD_ENDPOINT;
    // Durable browser renders belong to the endpoint/model configuration that
    // produced them. A settings change must not replay endpoint A under B.
    return `${id}@${revision}@runpod:${endpointId}`;
  }

  onProgress(callback) {
    this.progressListeners.add(callback);
    return () => this.progressListeners.delete(callback);
  }

  _notifyProgress(phase, message, error = null) {
    this.phase = phase;
    this.statusMessage = message;
    for (const listener of this.progressListeners) {
      try {
        listener({ phase, message, error });
      } catch (err) {
        console.warn('RunPod engine progress listener error:', err);
      }
    }
  }

  async init() {
    if (!this.hasConsent()) {
      this.isReady = false;
      this.phase = 'error';
      const error = new Error('Cloud voice consent is required before screenplay text can be sent to RunPod.');
      error.code = 'no_consent';
      this.lastError = error;
      this._notifyProgress('error', error.message, error);
      throw error;
    }
    const key = this.getApiKey().trim();
    if (!key) {
      this.isReady = false;
      this.phase = 'error';
      const error = new Error('RunPod API key is missing. Add your key in Engine Settings.');
      error.code = 'no_key';
      this.lastError = error;
      this._notifyProgress('error', error.message, error);
      throw error;
    }

    this.isLoading = true;
    this._notifyProgress('loading', 'Connecting to RunPod GPU...');

    try {
      const endpointId = this.getEndpointId() || DEFAULT_RUNPOD_ENDPOINT;
      const res = await fetch(`https://api.runpod.ai/v2/${endpointId}/health`, {
        headers: { authorization: `Bearer ${key}` },
      });

      if (!res.ok) {
        throw new Error(`RunPod returned HTTP ${res.status}`);
      }
      await readBoundedResponseJson(res, {
        maxBytes: 64 * 1024,
        tooLargeError: () => new Error('RunPod returned an oversized health response.'),
      });

      this.isReady = true;
      this.isLoading = false;
      this.lastError = null;
      this._notifyProgress('ready', 'RunPod GPU connected');
    } catch (err) {
      this.isReady = false;
      this.isLoading = false;
      this.lastError = err;
      this._notifyProgress('error', err.message, err);
      throw err;
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

  _evictOldest() {
    while (this.cachedSeconds > MAX_CACHED_SECONDS && this.audioCache.size > 0) {
      const oldestKey = this.audioCache.keys().next().value;
      const buffer = this.audioCache.get(oldestKey);
      this.audioCache.delete(oldestKey);
      if (buffer) {
        this.cachedSeconds -= buffer.duration || 0;
      }
    }
  }

  _cacheBuffer(key, buffer) {
    if (!buffer) return;
    if (this.audioCache.has(key)) {
      const prev = this.audioCache.get(key);
      this.cachedSeconds -= prev?.duration || 0;
    }
    this.audioCache.set(key, buffer);
    this.cachedSeconds += buffer.duration || 0;
    this._evictOldest();
  }

  async _getVoiceReferenceB64(voiceId, cacheId = voiceId) {
    if (!voiceId) return null;
    if (this._voiceBase64Cache.has(cacheId)) {
      return this._voiceBase64Cache.get(cacheId);
    }
    try {
      const sample = await getChatterboxVoiceSample(voiceId);
      if (sample && sample.length > 0) {
        const b64 = float32ToWavBase64(sample, 24000);
        this._voiceBase64Cache.set(cacheId, b64);
        while (this._voiceBase64Cache.size > MAX_REFERENCE_CACHE_ENTRIES) {
          this._voiceBase64Cache.delete(this._voiceBase64Cache.keys().next().value);
        }
        return b64;
      }
    } catch (err) {
      console.warn('Could not read voice reference sample:', err);
    }
    return null;
  }

  _bufferFromPcm(pcm, sampleRate = 24000) {
    const context = getAudioContext();
    if (!context) throw new Error('Web Audio is unavailable in this browser.');
    const samples = decodePcm16(pcm);
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  async _loadOrSynthesize(unit, signal) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (this.renderStore) {
      try {
        const stored = await this.renderStore.get(unit.key);
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (stored && stored.audio) {
          const buffer = this._bufferFromPcm(stored.audio, stored.sampleRate);
          if (buffer && !isAudioSilent(buffer)) {
            return buffer;
          }
        }
      } catch (err) {
        console.warn('RunPod render store read notice:', err);
      }
    }
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    const buffer = await this._synthesize(unit, signal);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (!buffer || isAudioSilent(buffer)) {
      throw new Error('RunPod worker returned empty or silent audio.');
    }

    if (this.renderStore && buffer) {
      try {
        const channelData =
          typeof buffer.getChannelData === 'function' ? buffer.getChannelData(0) : buffer.channelData?.[0] || null;
        if (channelData) {
          await this.renderStore.put(unit.key, channelData, buffer.sampleRate || 24000);
          if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        }
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') {
          throw new DOMException('aborted', 'AbortError');
        }
        console.warn('RunPod render store write notice:', err);
      }
    }
    return buffer;
  }

  async _synthesize(unit, signal) {
    if (!this.hasConsent()) {
      const error = new Error('Cloud voice consent was revoked.');
      error.code = 'no_consent';
      throw error;
    }
    const key = this.getApiKey().trim();
    const endpointId = this.getEndpointId().trim() || DEFAULT_RUNPOD_ENDPOINT;

    const voiceIdStr = String(unit.voiceId || '');
    const isKokoro =
      voiceIdStr.startsWith('af_') ||
      voiceIdStr.startsWith('am_') ||
      voiceIdStr.startsWith('bf_') ||
      voiceIdStr.startsWith('bm_') ||
      voiceIdStr.startsWith('zf_') ||
      voiceIdStr.startsWith('zm_');

    const voiceCacheId = unit.voiceCacheId || unit.voiceId;
    const refB64 = isKokoro ? null : await this._getVoiceReferenceB64(unit.voiceId, voiceCacheId);
    if (!isKokoro && !refB64) {
      throw new Error('This Studio voice is missing its reference recording. Add it again in casting.');
    }

    const payload = {
      input: {
        engine: isKokoro ? 'kokoro' : 'chatterbox',
        text: unit.text,
        voice: unit.voiceId || 'af_heart',
        // The worker cache is intentionally memory-only, but it lives for the
        // whole active script render. Include the revision so replacing a
        // stable browser voice ID cannot reuse its earlier speaker prompt.
        voice_id: voiceCacheId,
        reference_audio_b64: refB64,
        speed: unit.synthSpeed ?? unit.speed ?? 1.0,
        exaggeration: unit.exaggeration ?? 0.5,
      },
    };

    let res = null;
    for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      try {
        res = await fetch(`https://api.runpod.ai/v2/${endpointId}/runsync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(payload),
          signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        // A network failure can arrive after the provider accepted the POST.
        // Without a job id there is no safe way to distinguish that case, so do
        // not create a second potentially billable job.
        throw err;
      }

      if (res.ok) break;
      // 429 explicitly says the provider rejected this submission. Other HTTP
      // failures can be emitted after work was accepted, so retrying them could
      // create a second paid job without an identity for the first.
      if (RETRYABLE_SUBMISSION_STATUS.has(res.status) && attempts < MAX_ATTEMPTS) {
        try {
          await res.body?.cancel?.();
        } catch (_) {
          /* preserve HTTP status */
        }
        await sleep(500 * 2 ** attempts, signal);
        continue;
      }
      throw new Error(`RunPod HTTP ${res.status}`);
    }

    const data = await readBoundedResponseJson(res, {
      maxBytes: MAX_RUNPOD_RESPONSE_BYTES,
      signal,
      tooLargeError: () => new Error('RunPod returned too much audio data.'),
    });
    let audioB64 = '';

    if (data.status === 'COMPLETED') {
      if (data.output?.error) throw new Error(data.output.error);
      audioB64 = data.output?.audio_base64 || '';
    } else if (data.id && (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS')) {
      audioB64 = await this._pollJob(endpointId, data.id, key, signal);
    } else if (data.status === 'FAILED') {
      throw new Error(data.error || 'RunPod worker task failed');
    } else {
      throw new Error(data.error || `RunPod returned unexpected response (${data.status || 'unknown'})`);
    }

    if (!audioB64) throw new Error('No audio returned from RunPod');
    if (typeof audioB64 !== 'string' || audioB64.length > MAX_AUDIO_BASE64_CHARS) {
      throw new Error('RunPod returned too much audio data.');
    }

    let binary;
    try {
      binary = atob(audioB64);
    } catch (_) {
      throw new Error('RunPod returned invalid Base64 audio.');
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const audioCtx = getAudioContext();
    const buffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
    if (!buffer || buffer.duration <= 0.05 || buffer.duration > MAX_AUDIO_SECONDS || isAudioSilent(buffer)) {
      throw new Error('RunPod worker returned invalid, empty, or silent audio.');
    }
    return buffer;
  }

  async _pollJob(endpointId, jobId, apiKey, signal) {
    const statusUrl = `https://api.runpod.ai/v2/${endpointId}/status/${jobId}`;
    for (let i = 0; i < 40; i++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (i > 0) {
        await sleep(1500, signal);
      }

      const res = await fetch(statusUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });

      if (!res.ok) {
        if (RETRYABLE_POLL_STATUS.has(res.status)) {
          try {
            await res.body?.cancel?.();
          } catch (_) {
            /* preserve HTTP status */
          }
          continue;
        }
        throw new Error(`RunPod status check failed with HTTP ${res.status}`);
      }
      const data = await readBoundedResponseJson(res, {
        maxBytes: MAX_RUNPOD_RESPONSE_BYTES,
        signal,
        tooLargeError: () => new Error('RunPod returned too much audio data.'),
      });

      if (data.status === 'COMPLETED') {
        if (data.output?.error) {
          throw new Error(data.output.error);
        }
        return data.output?.audio_base64 || '';
      }
      if (data.status === 'FAILED' || data.status === 'CANCELLED' || data.status === 'TIMED_OUT') {
        throw new Error(data.error || `RunPod worker task ${data.status.toLowerCase()}`);
      }
    }
    throw new Error('RunPod job polling timed out');
  }

  _pumpQueue() {
    while (this.activeWorkers < CONCURRENCY && this.queue.length > 0) {
      // Sort queue by priority ascending
      this.queue.sort((a, b) => a.priority - b.priority);
      const item = this.queue.shift();
      if (!item) break;

      this.activeWorkers++;
      this._loadOrSynthesize(item.unit, item.controller.signal)
        .then((buffer) => {
          if (item.controller.signal.aborted || item.generation !== this.generation) {
            throw new DOMException('aborted', 'AbortError');
          }
          this._cacheBuffer(item.unit.key, buffer);
          item.resolve(buffer);
        })
        .catch((err) => {
          item.reject(err);
        })
        .finally(() => {
          this.activeWorkers--;
          if (this.pending.get(item.unit.key)?.promise === item.promise) {
            this.pending.delete(item.unit.key);
          }
          this._pumpQueue();
        });
    }
  }

  request(unit, priority = 1000) {
    if (!unit || !unit.key) return null;

    if (this.audioCache.has(unit.key)) {
      return Promise.resolve(this.audioCache.get(unit.key));
    }

    if (this.pending.has(unit.key)) {
      const entry = this.pending.get(unit.key);
      if (priority < entry.priority) {
        entry.priority = priority;
      }
      return entry.promise;
    }

    const controller = new AbortController();
    let pendingEntry;
    let resolvePromise;
    let rejectPromise;

    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }).finally(() => {
      if (this.pending.get(unit.key) === pendingEntry) {
        this.pending.delete(unit.key);
      }
    });

    pendingEntry = {
      unit,
      priority,
      controller,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      generation: this.generation,
    };

    this.pending.set(unit.key, pendingEntry);
    this.queue.push(pendingEntry);
    this._pumpQueue();

    return promise;
  }

  dropPendingExcept(keepKeys = []) {
    const keepSet = new Set(keepKeys);
    this.queue = this.queue.filter((item) => {
      if (!keepSet.has(item.unit.key)) {
        item.controller.abort();
        item.reject(new DOMException('aborted', 'AbortError'));
        this.pending.delete(item.unit.key);
        return false;
      }
      return true;
    });

    for (const [key, entry] of this.pending.entries()) {
      if (!keepSet.has(key)) {
        entry.controller.abort();
        this.pending.delete(key);
      }
    }
  }

  clearCache() {
    this.audioCache.clear();
    this.cachedSeconds = 0;
  }

  /** Release only script-owned memory; durable browser resume data stays local. */
  release() {
    this.generation++;
    this.dropPendingExcept([]);
    this.clearCache();
    this._voiceBase64Cache.clear();
    this.isReady = false;
    this.isLoading = false;
    this.phase = 'idle';
    this.statusMessage = 'Not connected';
    this.lastError = null;
  }
}

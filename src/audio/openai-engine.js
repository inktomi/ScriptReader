import { hasCloudConsent, loadOpenAIKey } from '../utils/credentials.js';
import { getAudioContext } from './audio-context.js';
import { ENGINE_IDS } from './engine-contract.js';
import { OPENAI_VOICE_CATALOG } from './voice-catalog.js';

/**
 * OpenAI `gpt-4o-mini-tts` synthesis service.
 *
 * Same contract as KokoroNeuralEngine — render text to AudioBuffers, cache them,
 * own no playback — so the scheduler, the lookahead loop, and every piece of
 * timing logic are untouched by which engine is active.
 *
 * There is deliberately **no worker**. Kokoro needs one because ONNX inference
 * blocks the thread for hundreds of milliseconds; here the local work is a fetch
 * plus an Int16→Float32 pass over a few hundred thousand samples, which is about
 * a millisecond. A worker would add a message hop and a transfer for nothing.
 */

const ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const MODEL = 'gpt-4o-mini-tts';

// Same budget as the Kokoro engine: roughly 25 minutes of speech.
const MAX_CACHED_SECONDS = 1500;

// The bottleneck is time-to-first-byte plus generation (~1-3s), not bandwidth, so
// a handful of parallel requests fills the lookahead window quickly. Higher than
// this buys little, reaches per-org rate limits sooner, and makes an abandoned
// seek more expensive — every in-flight request is money already committed.
const CONCURRENCY = 4;

const MAX_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Carries a stable code and whether the failure is worth stopping the read for. */
class EngineError extends Error {
  constructor(code, message, { fatal = false } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.fatal = fatal;
  }
}

/**
 * 500ms → 1s → 2s, ±25% jitter.
 *
 * The jitter is load-bearing. Four lookahead requests rate-limited by the same
 * 429 would otherwise back off in lockstep and hit the limit together again.
 */
function backoffMs(attempt) {
  return Math.round(500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * `response_format: 'pcm'` returns raw 24 kHz signed 16-bit little-endian mono
 * with no container and no header, so the bytes *are* the samples and there is
 * nothing to decode.
 *
 * That is why PCM beats mp3 or opus here: `decodeAudioData` would cost a decode
 * per chunk, and mp3 in particular prepends encoder delay that shows up as a few
 * milliseconds of silence at the head of every chunk — audible as a stutter the
 * moment chunks are butted together, which is the single thing this pipeline
 * exists to prevent.
 */
function pcm16ToAudioBuffer(ctx, arrayBuffer, sampleRate) {
  // A truncated body can leave a trailing odd byte; dropping it beats letting
  // the Int16Array constructor throw on a non-multiple-of-two length.
  const usableBytes = arrayBuffer.byteLength - (arrayBuffer.byteLength % 2);
  if (usableBytes <= 0) throw new EngineError('empty_audio', 'OpenAI returned no audio.');

  const pcm = new Int16Array(arrayBuffer, 0, usableBytes / 2);
  const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
  const channel = buffer.getChannelData(0);

  for (let i = 0; i < pcm.length; i++) {
    // 32768, not 32767: -32768 is representable and 32767 is not its mirror, so
    // dividing by 32767 lets a full-scale negative sample clip past -1.0.
    channel[i] = pcm[i] / 32768;
  }
  return buffer;
}

export class OpenAiTtsEngine {
  constructor({ getApiKey = loadOpenAIKey, hasConsent = hasCloudConsent } = {}) {
    this.getApiKey = getApiKey;
    this.hasConsent = hasConsent;

    this.isLoading = false;
    this.isReady = false;
    this.loadProgress = 0;
    this.statusMessage = 'Not configured';
    this.phase = 'idle';
    this.lastError = null;

    this.audioCache = new Map(); // key -> AudioBuffer
    this.cachedSeconds = 0;
    this.pending = new Map(); // key -> pending entry
    this.progressListeners = new Set();
    this.initPromise = null;

    this._seq = 0;
    this._inFlight = 0;
    this._pausedUntil = 0;

    // Measured, not predicted: accumulated from buffers that actually arrived.
    this.renderedSeconds = 0;
  }

  get capabilities() {
    return {
      id: ENGINE_IDS.OPENAI,
      label: 'OpenAI gpt-4o-mini-tts',
      // The speech endpoint accepts an exact numeric speed. Instructions still
      // carry acting direction, but transport and character pace must not be
      // approximated with prose bands.
      supportsSpeed: true,
      supportsInstructions: true,
      usesInstructionPitch: true,
      isLocal: false,
      metered: true,
      nativeSampleRate: 24000,
      // Far larger than Kokoro's 190. The model re-reads `instructions` for every
      // request, so splitting a speech into small pieces gives each piece
      // independently-invented prosody and an audible seam at every join.
      maxChunkChars: 4096,
      concurrency: CONCURRENCY,
      // Never silently drop a paying listener onto the browser's built-in voice:
      // if this engine cannot start, the reason is something they must act on.
      onUnavailable: 'error',
    };
  }

  resolveVoiceId(voiceProfile) {
    const candidate = voiceProfile && (voiceProfile.openaiId || voiceProfile.id);
    if (candidate && OPENAI_VOICE_CATALOG.some((v) => v.id === candidate)) return candidate;
    return OPENAI_VOICE_CATALOG[0].id;
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
      try {
        cb({
          progress,
          message,
          phase,
          isCachedLocally: false,
          engineId: ENGINE_IDS.OPENAI,
        });
      } catch (err) {
        console.error('Engine progress subscriber error:', err);
      }
    }
  }

  /**
   * There is no model to download, so "init" is only a key check. Kept async and
   * idempotent so the manager can await it exactly as it awaits Kokoro's.
   */
  init() {
    if (this.isReady) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.isLoading = true;
      this.notifyProgress(10, 'Checking OpenAI credentials…', 'loading');

      if (!this.hasConsent()) {
        this.isLoading = false;
        this.isReady = false;
        const error = new EngineError(
          'no_consent',
          'Cloud voice consent is required before screenplay text can be sent to OpenAI.',
          { fatal: true },
        );
        this.lastError = error;
        this.notifyProgress(0, error.message, 'error');
        throw error;
      }

      const key = this.getApiKey();
      if (!key) {
        this.isLoading = false;
        this.isReady = false;
        const error = new EngineError(
          'no_key',
          'No OpenAI API key set. Add one in Voice Engine settings, or switch back to Kokoro.',
          { fatal: true },
        );
        this.lastError = error;
        this.notifyProgress(0, error.message, 'error');
        throw error;
      }

      this.isLoading = false;
      this.isReady = true;
      this.lastError = null;
      this._pausedUntil = 0;
      this.notifyProgress(100, 'OpenAI voices ready — dialogue is sent to OpenAI to be spoken.', 'ready');
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
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
   * Queue a unit for synthesis. Safe to call every tick: cached units are no-ops
   * and queued units only get their priority raised.
   */
  request(unit, priority = 1000) {
    if (!this.isReady) return null;

    const cached = this.audioCache.get(unit.key);
    if (cached) return Promise.resolve(cached);

    const existing = this.pending.get(unit.key);
    if (existing) {
      if (priority < existing.priority) existing.priority = priority;
      return existing.promise;
    }

    const controller = new AbortController();
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    // Lookahead rejections are expected — a seek drops them — and must not
    // surface as unhandled rejections. Callers that care attach their own.
    promise.catch(() => {});

    this.pending.set(unit.key, {
      unit,
      priority,
      seq: this._seq++,
      controller,
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      started: false,
    });

    this._pump();
    return promise;
  }

  /**
   * Start work while slots are free, always choosing the unit the listener needs
   * soonest. Same (priority, seq) selection as the Kokoro worker's queue, so both
   * engines behave identically under a seek.
   */
  _pump() {
    if (!this.isReady) return;

    // Feeding a rate-limited endpoint through the whole backoff window is how one
    // 429 becomes a sustained 429.
    const now = Date.now();
    if (now < this._pausedUntil) {
      setTimeout(() => this._pump(), this._pausedUntil - now);
      return;
    }

    while (this._inFlight < CONCURRENCY) {
      let best = null;
      for (const entry of this.pending.values()) {
        if (entry.started) continue;
        if (!best || entry.priority < best.priority || (entry.priority === best.priority && entry.seq < best.seq)) {
          best = entry;
        }
      }
      if (!best) return;

      best.started = true;
      this._inFlight++;
      this._run(best);
    }
  }

  async _run(entry) {
    try {
      const buffer = await this._synthesize(entry.unit, entry.controller.signal);
      if (this.pending.get(entry.unit.key) === entry) {
        this.pending.delete(entry.unit.key);
      }
      this._store(entry.unit.key, buffer);
      this.renderedSeconds += buffer.duration;
      entry.resolve(buffer);
    } catch (error) {
      if (this.pending.get(entry.unit.key) === entry) {
        this.pending.delete(entry.unit.key);
      }

      if (error && error.fatal) {
        // Stop the lookahead loop dead rather than burning further requests — and
        // money — against a key that will refuse every one of them.
        this.isReady = false;
        this.lastError = error;
        this.notifyProgress(0, error.message, 'error');
        this._rejectPending(error);
      } else if (!error || error.name !== 'AbortError') {
        this.lastError = error;
        this.notifyProgress(
          0,
          (error && error.message) || 'OpenAI speech synthesis failed.',
          // One exhausted render does not make the engine unusable. Reporting a
          // warning keeps already-buffered dialogue playing while the manager
          // can request that unit again if it is still needed.
          'warning',
        );
      }
      entry.reject(error);
    } finally {
      this._inFlight--;
      this._pump();
    }
  }

  /** Reject and abort every queued request after an engine-wide failure. */
  _rejectPending(error) {
    for (const [key, pendingEntry] of Array.from(this.pending)) {
      this.pending.delete(key);
      pendingEntry.controller.abort();
      pendingEntry.reject(error);
    }
  }

  async _synthesize(unit, signal) {
    if (!this.hasConsent()) {
      throw new EngineError('no_consent', 'Cloud voice consent was revoked.', { fatal: true });
    }
    const key = this.getApiKey();
    if (!key) throw new EngineError('no_key', 'No OpenAI API key set.', { fatal: true });

    const body = {
      model: MODEL,
      voice: unit.voiceId,
      input: unit.text,
      speed: Math.min(4, Math.max(0.25, Number(unit.synthSpeed) || 1)),
      // Raw samples at the rate the AudioContext already runs at: no decode, no
      // encoder delay, no resampling.
      response_format: 'pcm',
    };
    // Omitted rather than sent empty, so a line with nothing to say about it does
    // not carry a paragraph telling the model to be normal.
    if (unit.instructions) body.instructions = unit.instructions;

    const response = await this._fetchWithRetry({
      // Plain fetch, never the `openai` npm SDK. The SDK attaches x-stainless-*
      // telemetry headers, none of which are in this endpoint's
      // access-control-allow-headers list, so the CORS preflight fails and the
      // request never leaves the browser. This is the cause of most reports that
      // "the OpenAI API doesn't support CORS" — the API does; the SDK doesn't.
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    const arrayBuffer = await response.arrayBuffer();
    const ctx = getAudioContext();
    if (!ctx) throw new EngineError('no_audio_context', 'Web Audio is unavailable in this browser.');

    return pcm16ToAudioBuffer(ctx, arrayBuffer, this.capabilities.nativeSampleRate);
  }

  async _fetchWithRetry({ headers, body, signal }) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetch(ENDPOINT, { method: 'POST', headers, body, signal });
      } catch (err) {
        // An abort is a seek, not a failure. Retrying would resurrect work the
        // listener has already jumped away from, and pay for it.
        if (err.name === 'AbortError') throw err;
        if (attempt >= MAX_ATTEMPTS) {
          throw new EngineError('network', 'Could not reach OpenAI. Check your connection.');
        }
        await sleep(backoffMs(attempt), signal);
        continue;
      }

      if (response.ok) return response;

      const error = await this._describeError(response);
      if (!RETRYABLE_STATUS.has(response.status) || error.fatal || attempt >= MAX_ATTEMPTS) {
        throw error;
      }

      // Honour Retry-After when the server sends one; it knows better than our
      // exponent does.
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);

      this._pausedUntil = Date.now() + wait;
      this.notifyProgress(this.loadProgress, 'OpenAI is rate limiting — slowing down…', 'loading');
      await sleep(wait, signal);
    }
  }

  async _describeError(response) {
    let detail = '';
    try {
      const json = await response.json();
      detail = (json && json.error && json.error.message) || '';
    } catch {
      // Non-JSON body; the status alone will have to carry the message.
    }
    const isQuota = /quota|billing|insufficient|exceeded your current/i.test(detail);

    switch (response.status) {
      case 401:
        return new EngineError('invalid_key', 'OpenAI rejected the API key. Check it in Voice Engine settings.', {
          fatal: true,
        });
      case 403:
        return new EngineError('forbidden', 'This key is not permitted to use the speech endpoint.', { fatal: true });
      case 429:
        return isQuota
          ? new EngineError('quota', 'The OpenAI account is out of credit. Add billing, or switch back to Kokoro.', {
              fatal: true,
            })
          : new EngineError('rate_limit', 'OpenAI is rate limiting this key.');
      default:
        return new EngineError(
          `http_${response.status}`,
          `OpenAI returned ${response.status}${detail ? `: ${detail}` : ''}`,
        );
    }
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
   * Deliberately stricter than the Kokoro worker's equivalent.
   *
   * There, in-flight work is allowed to finish because it is already paid for in
   * wall-clock and the result still lands in the cache. Here an abandoned render
   * costs money — and, more immediately, holds one of only four concurrency slots
   * that the line the listener actually jumped to now needs.
   */
  dropPendingExcept(keepKeys = []) {
    const keep = new Set(keepKeys);
    for (const [key, entry] of Array.from(this.pending)) {
      if (keep.has(key)) continue;
      entry.controller.abort();
      this.pending.delete(key);
      entry.reject(new DOMException('dropped', 'AbortError'));
    }
  }

  clearCache() {
    this.audioCache.clear();
    this.cachedSeconds = 0;
  }
}

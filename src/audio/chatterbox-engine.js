import { ENGINE_IDS } from './engine-contract.js';
import { getAudioContext } from './audio-context.js';
import { ModelCacheManager } from './model-cache-manager.js';
import { getChatterboxVoiceSample } from './chatterbox-voice-store.js';
import { createOpfsModelCache } from './opfs-model-cache.js';
import { chatterboxRenderStore, decodePcm16 } from './chatterbox-render-store.js';
import {
  CHATTERBOX_DOWNLOAD_BYTES,
  CHATTERBOX_MODEL_ID,
  OPFS_NAMESPACE,
  expectedBytesForUrl,
  expectedFilesFor,
  expectedTotalBytes,
  isCompleteSize,
  pickChatterboxDevice
} from './chatterbox-model-files.js';

// Re-exported because the settings modal and the tests import them from here.
export { CHATTERBOX_DOWNLOAD_BYTES, CHATTERBOX_MODEL_ID };

const MAX_CACHED_SECONDS = 1500;

// Files below this are configs and tokenizers. They are a few kilobytes and
// arrive first, so counting them would drive the bar to 100% in a second and
// snap it back the moment the weights joined the total.
const SIGNIFICANT_BYTES = 1024 * 1024;

// The bar is divided between the two things that actually take time. Downloading
// owns 8-80; reading the model back off disk and building the ONNX sessions owns
// 80-95, with the creep below reaching 97. 100 belongs to `ready` alone.
const STAGE_BANDS = {
  download: [8, 80],
  building: [80, 95]
};

// While ORT instantiates four sessions from ~1.4 GB there is no signal of any
// kind. A bar that creeps says "alive, duration unknown"; a bar frozen at 100%
// says nothing, which is the thing this whole change exists to stop doing.
const CREEP_INTERVAL_MS = 3000;
const CREEP_CEILING = 97;

// Long enough that a slow link between chunks is not mistaken for a hang.
const STALL_HINT_MS = 30000;

// Hard deadlines. These are what turn an OOM-killed worker — which fires no
// error event at all — into an actionable failure instead of a permanent
// "Installing…". Generous, because both stages legitimately take minutes.
const DOWNLOAD_DEADLINE_MS = 180000;
const BUILDING_DEADLINE_MS = 600000;

// Error messages reach the DOM. A runtime or bundler failure can carry an entire
// minified module as its message, so nothing goes on screen unbounded.
const MAX_MESSAGE_CHARS = 300;

function truncate(text) {
  const value = typeof text === 'string' ? text : '';
  return value.length > MAX_MESSAGE_CHARS ? `${value.slice(0, MAX_MESSAGE_CHARS)}…` : value;
}

/**
 * What is actually on this device, checked file by file against the dtype set
 * the worker would pick.
 *
 * The previous version counted Cache Storage keys whose URL contained `.onnx`
 * and called four a complete install. Three things were wrong with that: the
 * `.onnx_data` sidecars also match `.onnx`, so the four tiny graph files alone
 * satisfied it with no weights present at all; Chromium refuses to store bodies
 * this large in the first place, so that was the normal outcome rather than an
 * edge case; and it could not tell a wasm install (`language_model_q4`) from a
 * WebGPU one (`q4f16`), so a device switch reported "installed" and then
 * silently re-downloaded.
 */
export async function getChatterboxCacheStatus(preferredDevice = 'auto') {
  const persisted = await ModelCacheManager.isStoragePersisted();
  const cache = await createOpfsModelCache(OPFS_NAMESPACE);

  if (!cache) {
    return {
      installed: false,
      partial: false,
      storable: false,
      device: null,
      weightFiles: { cached: 0, expected: 0 },
      cachedBytes: 0,
      expectedBytes: 0,
      missing: [],
      fileCount: 0,
      persisted
    };
  }

  const device = await pickChatterboxDevice(preferredDevice);
  const files = expectedFilesFor(device);
  const missing = [];
  let fileCount = 0;
  let cachedBytes = 0;
  let weightsCached = 0;

  for (const file of files) {
    const size = await cache.sizeOf(file.url);
    if (isCompleteSize(size, file.bytes)) {
      fileCount++;
      cachedBytes += size;
      if (file.isWeights) weightsCached++;
    } else {
      missing.push(file.path);
    }
  }

  return {
    installed: missing.length === 0,
    partial: missing.length > 0 && fileCount > 0,
    storable: true,
    device,
    weightFiles: { cached: weightsCached, expected: files.filter(file => file.isWeights).length },
    cachedBytes,
    expectedBytes: expectedTotalBytes(device),
    missing,
    fileCount,
    persisted
  };
}

/**
 * Remove the model from this device.
 *
 * Sweeps Cache Storage as well as OPFS: earlier builds wrote the small graph
 * files there, and those leftovers are exactly what made the old install probe
 * claim a model that had no weights behind it.
 */
export async function clearChatterboxCache() {
  const cache = await createOpfsModelCache(OPFS_NAMESPACE);
  const clearedOpfs = cache ? await cache.clear() : false;
  const sweptLegacy = await ModelCacheManager.clearMatchingEntries(
    url => url.toLowerCase().includes('chatterbox-onnx')
  );
  const clearedRenders = await chatterboxRenderStore.clear();
  return clearedOpfs || sweptLegacy || clearedRenders;
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
  constructor({ renderStore = chatterboxRenderStore } = {}) {
    this.worker = null;
    this.msgId = 0;
    this.resolvers = new Map();
    this.audioCache = new Map();
    this.cachedSeconds = 0;
    this.pending = new Map();
    this.voiceSamples = new Map();
    this.renderStore = renderStore;
    this.progressListeners = new Set();
    this.initPromise = null;
    this.isLoading = false;
    this.isReady = false;
    this.isCachedLocally = false;
    this.loadProgress = 0;
    this.statusMessage = 'Not installed';
    this.phase = 'idle';

    // Orthogonal to `phase`, deliberately. `phase` is the four-value union in
    // engine-contract.js that the audio manager branches on to decide an engine
    // has died; widening it is how the stray 'warning' value got in. What stage
    // of loading we are at is a different question and gets its own field.
    this.stage = 'idle';

    this.device = null;
    this.lastError = null;

    // file -> { loaded, total, totalTrusted, status }
    this.fileProgress = new Map();
    this._loadingBaseMessage = '';
    this._maxOverall = 0;
    this._lastEmitted = null;
    this._stallTimer = null;
    this._deadlineTimer = null;
    this._creepTimer = null;
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

  resolveVoiceCacheId(profile) {
    const id = this.resolveVoiceId(profile);
    return profile?.renderRevision ? `${id}@${profile.renderRevision}` : `${id}@v2`;
  }

  onProgress(callback) {
    this.progressListeners.add(callback);
    return () => this.progressListeners.delete(callback);
  }

  notifyProgress(progress, message, phase = 'loading') {
    this.loadProgress = progress;
    this.statusMessage = message;
    this.phase = phase;
    const payload = {
      progress,
      message,
      phase,
      stage: this.stage,
      isCachedLocally: this.isCachedLocally,
      error: this.lastError
    };
    for (const callback of this.progressListeners) {
      // One throwing subscriber used to silence every later one — and because
      // this runs inside _init's try block, a listener that threw on the success
      // path turned a completed install into a reported failure.
      try {
        callback(payload);
      } catch (err) {
        console.error('Studio Local progress subscriber error:', err);
      }
    }
  }

  /**
   * Emit a loading update, ratcheted and de-duplicated.
   *
   * The ratchet is not cosmetic. The denominator legitimately changes mid-flight
   * — when a file's total becomes trustworthy, and when a WebGPU failure falls
   * back to wasm and swaps one weight file for another — and without this the
   * bar would visibly walk backwards.
   */
  _emitLoading(percent, message) {
    const next = Math.max(this._maxOverall, Math.min(99, Math.round(percent)));
    this._maxOverall = next;
    if (this._lastEmitted && this._lastEmitted.progress === next && this._lastEmitted.message === message) {
      return;
    }
    this._lastEmitted = { progress: next, message };
    this.notifyProgress(next, message, 'loading');
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
    if (type === 'error' || type === 'dropped') {
      resolver.reject(new Error(truncate(error) || 'Studio voice generation failed.'));
    } else {
      resolver.resolve(payload);
    }
  }

  /**
   * Fold one coalesced batch from the worker into the aggregate byte counts.
   *
   * The worker sends `{ stage, files: [{ file, loaded, total, status }] }` at
   * most once per 150 ms. It has to coalesce there rather than here, because
   * `init_complete` shares the same message queue: an unthrottled relay does not
   * just make the bar expensive to draw, it puts completion behind a backlog.
   */
  _noteProgress(payload) {
    const stage = payload.stage || 'download';

    if (stage === 'download' && this.stage === 'building') {
      // A WebGPU failure falling back to wasm restarts downloading for the one
      // weight file that differs. The ratchet has to give way here or the bar
      // would sit at its building-stage high-water mark through a fresh 350 MB.
      this._maxOverall = 0;
      this._lastEmitted = null;
      this._stopCreep();
    }

    const stageChanged = this.stage !== stage;
    this.stage = stage;

    for (const entry of payload.files || []) {
      if (!entry || typeof entry.file !== 'string') continue;
      const known = this.fileProgress.get(entry.file) || { loaded: 0, total: 0, totalTrusted: false };
      const loaded = Number(entry.loaded) || known.loaded;
      const total = Number(entry.total) || known.total;
      // A total is only believable once it has been seen to exceed what had
      // already arrived. When a response has no Content-Length, transformers.js
      // grows `total` to match `loaded` on every chunk, so `loaded === total`
      // forever is the exact signature of a total that means nothing. The only
      // file that could be misread this way is one finishing in a single chunk,
      // which is the sub-megabyte config set filtered out below.
      const totalTrusted = known.totalTrusted || (total > 0 && total > loaded);
      this.fileProgress.set(entry.file, {
        loaded,
        total,
        totalTrusted,
        status: entry.status || known.status
      });
    }

    this._armStallWatchdog();
    if (stageChanged) {
      this._armDeadline(stage === 'building' ? BUILDING_DEADLINE_MS : DOWNLOAD_DEADLINE_MS);
    } else if (stage === 'download') {
      this._armDeadline(DOWNLOAD_DEADLINE_MS);
    }
    if (stage === 'building') this._startCreep();

    this._publishProgress();
  }

  _publishProgress() {
    let loadedBytes = 0;
    let totalBytes = 0;

    for (const [file, entry] of this.fileProgress) {
      // A total the response actually vouched for wins: it describes the bytes
      // in flight right now, where the published size is a figure recorded when
      // this module was written. Only when there is no trustworthy total does the
      // published size stand in.
      //
      // A file that is neither trustworthy nor known is left out entirely rather
      // than counted against its own `loaded` — treating a running byte count as
      // its own denominator is what pins a bar at 100% forever, which is the
      // failure this whole path exists to avoid.
      const size = (entry.totalTrusted ? entry.total : 0) || expectedBytesForUrl(file);
      if (size < SIGNIFICANT_BYTES) continue;
      loadedBytes += Math.min(entry.loaded, size);
      totalBytes += size;
    }

    const [floor, ceiling] = STAGE_BANDS[this.stage] || STAGE_BANDS.download;

    if (totalBytes === 0) {
      this._emitLoading(floor, this._loadingBaseMessage || 'Preparing Studio Local…');
      return;
    }

    const percent = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
    const size = `${ModelCacheManager.formatBytes(loadedBytes)} / ${ModelCacheManager.formatBytes(totalBytes)}`;
    const verb = this.stage === 'building'
      ? 'Loading the voice model from this device'
      : (this.isCachedLocally ? 'Verifying Studio Local' : 'Downloading Studio Local');

    this._loadingBaseMessage = `${verb}: ${percent}% · ${size}`;
    this._emitLoading(floor + (percent / 100) * (ceiling - floor), this._loadingBaseMessage);
  }

  /**
   * Advance the bar during the silent window while ORT builds its sessions.
   *
   * The message changes too: "Downloading" has to stop being the word on screen
   * the moment the last byte lands, or a minute of session building reads as a
   * download that stopped moving.
   */
  _startCreep() {
    if (this._creepTimer) return;
    this._creepTimer = setInterval(() => {
      if (this.phase !== 'loading' || this.stage !== 'building') {
        this._stopCreep();
        return;
      }
      this._loadingBaseMessage = 'Preparing the voice model — building four speech models from 1.4 GB. This can take a minute.';
      this._emitLoading(Math.min(CREEP_CEILING, this._maxOverall + 1), this._loadingBaseMessage);
    }, CREEP_INTERVAL_MS);
  }

  _stopCreep() {
    if (this._creepTimer) {
      clearInterval(this._creepTimer);
      this._creepTimer = null;
    }
  }

  /**
   * A non-fatal hint, re-armed rather than escalating. The suffix is rebuilt
   * from the stored base message each time so it can never compound.
   */
  _armStallWatchdog() {
    if (this._stallTimer) clearTimeout(this._stallTimer);
    this._stallTimer = setTimeout(() => {
      if (this.phase !== 'loading') return;
      const seconds = Math.round(STALL_HINT_MS / 1000);
      const base = this._loadingBaseMessage || this.statusMessage;
      this.notifyProgress(this.loadProgress, `${base} — still working (no update for ${seconds}s)`, 'loading');
      this._armStallWatchdog();
    }, STALL_HINT_MS);
  }

  /**
   * The fatal one. Kokoro has no equivalent and does not need one: its worker
   * fails loudly. This engine's worker holds ~1.4 GB and can be killed by the
   * browser for memory, which fires no `error`, no `messageerror`, and no close
   * event — the init promise simply never settles. This timer is the only thing
   * that can end that wait.
   */
  _armDeadline(ms) {
    if (this._deadlineTimer) clearTimeout(this._deadlineTimer);
    this._deadlineTimer = setTimeout(() => {
      const where = this.stage === 'building' ? 'building the voice model' : 'downloading the voice model';
      this._handleWorkerCrash(new Error(
        `Studio Local stopped responding while ${where}. This browser most likely ran out of memory. Try again, or switch to Kokoro.`
      ));
    }, ms);
  }

  _clearTimers() {
    if (this._stallTimer) clearTimeout(this._stallTimer);
    if (this._deadlineTimer) clearTimeout(this._deadlineTimer);
    this._stallTimer = null;
    this._deadlineTimer = null;
    this._stopCreep();
  }

  _teardownWorker() {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  /**
   * The old `onerror` rejected pending resolvers and stopped there: `isReady`
   * stayed true, `lastError` stayed null, no error phase was emitted and the
   * dead worker was never torn down — so `play()` would skip re-init and every
   * later request hung on a resolver nobody would settle.
   */
  _handleWorkerCrash(err) {
    const error = err instanceof Error
      ? err
      : new Error(truncate(err?.message) || 'The Studio Local worker stopped unexpectedly.');
    error.reported = true;

    const pending = [...this.resolvers.values()];
    this.resolvers.clear();
    for (const { reject } of pending) reject(error);

    this.isLoading = false;
    this.isReady = false;
    this.lastError = error;
    this.stage = 'idle';
    this._clearTimers();
    this._teardownWorker();
    this.notifyProgress(0, truncate(error.message), 'error');
  }

  /** Cancel an install in progress. Terminating the worker aborts its fetches. */
  abortInit() {
    if (!this.isLoading) return;
    const error = new Error('Studio Local installation was cancelled.');
    error.reported = true;
    // Distinguishes a deliberate stop from a failure, so the UI does not present
    // the user's own Cancel back to them as an error.
    error.cancelled = true;

    const pending = [...this.resolvers.values()];
    this.resolvers.clear();
    for (const { reject } of pending) reject(error);

    this.isLoading = false;
    this.isReady = false;
    this.lastError = null;
    this.stage = 'idle';
    this._clearTimers();
    this._teardownWorker();
    this.notifyProgress(0, 'Installation cancelled.', 'idle');
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
    this._maxOverall = 0;
    this._lastEmitted = null;
    this.stage = 'probe';

    await ModelCacheManager.requestPersistentStorage();
    const before = await getChatterboxCacheStatus(device);
    this.isCachedLocally = before.installed;
    this._loadingBaseMessage = before.installed
      ? 'Loading Studio Local from this device…'
      : 'Preparing the one-time Studio Local download…';
    this._emitLoading(before.installed ? 18 : 5, this._loadingBaseMessage);

    try {
      this.worker = new Worker(new URL('./chatterbox-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = event => this._onWorkerMessage(event);
      this.worker.onerror = event => this._handleWorkerCrash(
        new Error(truncate(event?.message) || 'The Studio Local worker stopped unexpectedly.')
      );
      this.worker.onmessageerror = () => this._handleWorkerCrash(
        new Error('The Studio Local worker sent an unreadable message.')
      );

      this.stage = 'download';
      this._armStallWatchdog();
      this._armDeadline(DOWNLOAD_DEADLINE_MS);

      const result = await new Promise((resolve, reject) => {
        const id = ++this.msgId;
        this.resolvers.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'init', id, payload: { device } });
      });

      this._clearTimers();
      this.device = result?.device || 'wasm';
      this.stage = 'done';

      // Re-read rather than assume: a browser without OPFS runs the engine
      // happily and keeps nothing, and that difference is the whole of whether
      // "installed" is true.
      const after = await getChatterboxCacheStatus(this.device);
      this.isCachedLocally = after.installed;
      this.isReady = true;
      this.isLoading = false;

      const acceleration = this.device === 'webgpu' ? 'WebGPU' : 'WASM';
      let message;
      if (after.installed) {
        message = `Studio Local is installed and ready offline · ${acceleration}`;
      } else if (result && result.retained === false) {
        message = `Studio Local is ready · ${acceleration}. This browser cannot store the model, so it will download again next session.`;
      } else {
        message = `Studio Local is ready · ${acceleration}, but not every file was retained — part of it will download again.`;
      }
      this.notifyProgress(100, message, 'ready');

      getAudioContext();
      return true;
    } catch (error) {
      this.isLoading = false;
      this.isReady = false;
      this.stage = 'idle';
      this._clearTimers();
      this._teardownWorker();
      this.resolvers.clear();
      // _handleWorkerCrash and abortInit have already emitted for their own
      // errors; re-announcing here would overwrite a specific diagnosis with a
      // generic one.
      if (!error?.reported) {
        this.lastError = error;
        this.notifyProgress(0, `Studio Local installation failed: ${truncate(error?.message)}`, 'error');
      }
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

    const promise = this._loadOrSynthesize(unit, priority)
      .then(buffer => {
        this.pending.delete(unit.key);
        this._store(unit.key, buffer);
        return buffer;
      })
      .catch(error => {
        this.pending.delete(unit.key);
        // Recorded but not broadcast. The rejection already propagates to the
        // caller, and emitting a progress update from here is how the invalid
        // 'warning' phase got in — while emitting a valid 'error' phase would be
        // worse still, since the audio manager reads that as engine death and
        // would tear down playback over one failed line.
        this.lastError = error;
        throw error;
      });
    promise.catch(() => {});
    this.pending.set(unit.key, { promise, priority });
    return promise;
  }

  async _loadOrSynthesize(unit, priority) {
    const stored = await this.renderStore.get(unit.key);
    if (stored) return this._bufferFromPcm(stored.audio, stored.sampleRate);

    const buffer = await this._synthesize(unit, priority);
    await this.renderStore.put(unit.key, buffer.getChannelData(0), buffer.sampleRate);
    return buffer;
  }

  _bufferFromPcm(pcm, sampleRate = 24000) {
    const context = getAudioContext();
    if (!context) throw new Error('Web Audio is unavailable in this browser.');
    const samples = decodePcm16(pcm);
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
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
    this._clearTimers();
    this._teardownWorker();
    this.isReady = false;
    this.isLoading = false;
    this.clearCache();
    this.voiceSamples.clear();
    this.phase = 'idle';
    this.stage = 'idle';
    this.statusMessage = this.isCachedLocally ? 'Installed · not loaded' : 'Not loaded';
  }
}

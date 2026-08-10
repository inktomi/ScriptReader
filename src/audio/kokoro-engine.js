import { ModelCacheManager, DEFAULT_MODEL_ID } from './model-cache-manager.js';

export class KokoroNeuralEngine {
  constructor() {
    this.worker = null;
    this.msgId = 0;
    this.resolvers = new Map();
    this.playToken = 0;
    this.isLoading = false;
    this.isReady = false;
    this.loadProgress = 0;
    this.statusMessage = 'Not loaded';
    this.isCachedLocally = false;
    this.audioCtx = null;
    this.currentSource = null;
    this.gainNode = null;
    this.audioCache = new Map(); // cacheKey -> AudioBuffer
    this.pendingSyntheses = new Map(); // cacheKey -> Promise<AudioBuffer>
    this.progressListeners = new Set();
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
      const p = payload;
      const base = this.isCachedLocally ? 30 : 20;
      const factor = this.isCachedLocally ? 0.6 : 0.7;
      const overall = base + Math.round(p.progress * factor);
      const msg = this.isCachedLocally
        ? `Loading local weights: ${Math.round(p.progress * 100)}%`
        : `Downloading neural voice weights: ${Math.round(p.progress * 100)}%`;
      this.notifyProgress(overall, msg);
    } else if (id && this.resolvers.has(id)) {
      const { resolve, reject } = this.resolvers.get(id);
      this.resolvers.delete(id);
      
      if (type === 'error') {
        reject(new Error(error));
      } else {
        resolve(payload);
      }
    }
  }

  async init(device = 'wasm') {
    if (this.isReady) return true;
    if (this.isLoading) return false;

    this.isLoading = true;
    this.notifyProgress(5, 'Initializing Kokoro Neural Engine (WASM/WebGPU)...');

    try {
      // 1. Ensure browser grants persistent storage
      await ModelCacheManager.requestPersistentStorage();

      // 2. Inspect if model is already stored locally
      const cacheStatus = await ModelCacheManager.getModelCacheStatus(DEFAULT_MODEL_ID);
      this.isCachedLocally = cacheStatus.isModelCached;

      if (cacheStatus.isModelCached) {
        this.notifyProgress(30, '⚡ Loading Kokoro-82M from local cache...');
      } else {
        this.notifyProgress(15, 'Downloading Kokoro-82M ONNX model weights to local cache...');
      }

      this.worker = new Worker(new URL('./kokoro-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.handleWorkerMessage(e);

      await new Promise((resolve, reject) => {
        const id = ++this.msgId;
        this.resolvers.set(id, { resolve, reject });
        this.worker.postMessage({
          type: 'init',
          id,
          payload: { modelId: DEFAULT_MODEL_ID, device }
        });
      });

      this.isReady = true;
      this.isLoading = false;
      this.isCachedLocally = true;

      const readyMsg = cacheStatus.isModelCached
        ? '⚡ Kokoro Neural Engine ready (Loaded from local cache)'
        : 'Kokoro Neural Engine ready & cached locally';
      this.notifyProgress(100, readyMsg);

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }

      // 4. Background-cache all 28 character voices so switching voices never hits the network
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

  getCacheKey(voiceProfile, text, nuance, speedMultiplier) {
    const voiceId = voiceProfile.kokoroId || 'af_heart';
    const effectiveSpeed = Math.min(1.4, Math.max(0.75, (voiceProfile.defaultSpeed || 1.0) * speedMultiplier * (nuance.rateMod || 1.0)));
    const spokenText = nuance.cleanSpeech || text;
    return `${voiceId}_${effectiveSpeed.toFixed(2)}_${spokenText.trim()}`;
  }

  /**
   * Background look-ahead synthesis: pre-renders upcoming lines into AudioBuffer memory
   */
  async preBufferUpcoming(items = []) {
    if (!this.isReady || !this.worker) return;

    for (const item of items) {
      if (!item || !item.text) continue;
      const cacheKey = this.getCacheKey(item.voiceProfile, item.text, item.nuance || {}, item.speedMultiplier || 1.0);
      if (this.audioCache.has(cacheKey) || this.pendingSyntheses.has(cacheKey)) {
        continue;
      }

      // Synthesize in background (fire and forget, handles its own caching/queuing)
      this.synthesize(item).catch(() => {
        // Silently skip pre-buffer failure
      });
    }
  }

  /**
   * Synthesize audio for text and voice profile with natural prosody
   */
  async synthesize({ text, voiceProfile, nuance = {}, speedMultiplier = 1.0 }) {
    if (!this.isReady || !this.worker) {
      throw new Error('Kokoro neural engine is not initialized yet.');
    }

    const voiceId = voiceProfile.kokoroId || 'af_heart';
    const effectiveSpeed = Math.min(1.4, Math.max(0.75, (voiceProfile.defaultSpeed || 1.0) * speedMultiplier * (nuance.rateMod || 1.0)));
    const spokenText = (nuance.cleanSpeech || text).trim();

    if (!spokenText) {
      throw new Error('Empty text for synthesis');
    }

    const cacheKey = `${voiceId}_${effectiveSpeed.toFixed(2)}_${spokenText}`;
    if (this.audioCache.has(cacheKey)) {
      return this.audioCache.get(cacheKey);
    }

    if (this.pendingSyntheses.has(cacheKey)) {
      return await this.pendingSyntheses.get(cacheKey);
    }

    const synthPromise = (async () => {
      try {
        const rawAudio = await new Promise((resolve, reject) => {
          const id = ++this.msgId;
          this.resolvers.set(id, { resolve, reject });
          this.worker.postMessage({
            type: 'generate',
            id,
            payload: {
              text: spokenText,
              voiceId,
              speed: effectiveSpeed
            }
          });
        });

        if (!this.audioCtx) {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          this.audioCtx = new AudioContextClass();
        }

        const audioBuffer = this.audioCtx.createBuffer(
          1,
          rawAudio.audio.length,
          rawAudio.sampling_rate || 24000
        );
        audioBuffer.copyToChannel(rawAudio.audio, 0);

        this.audioCache.set(cacheKey, audioBuffer);
        this.pendingSyntheses.delete(cacheKey);
        return audioBuffer;
      } catch (err) {
        this.pendingSyntheses.delete(cacheKey);
        throw err;
      }
    })();

    this.pendingSyntheses.set(cacheKey, synthPromise);
    return await synthPromise;
  }

  /**
   * Plays a synthesized line with sample-accurate Web Audio API
   */
  async playLine({ text, voiceProfile, nuance = {}, pitchOffset = 0, speedMultiplier = 1.0, onStart, onEnd, onError }) {
    const currentToken = ++this.playToken;
    try {
      const audioBuffer = await this.synthesize({ text, voiceProfile, nuance, speedMultiplier });

      if (this.playToken !== currentToken) {
        return; // playback was stopped or superseded
      }

      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContextClass();
      }

      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      this.stop();

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;

      // Soft envelope gain to eliminate clicks and pops
      const gainNode = this.audioCtx.createGain();
      const targetGain = Math.min(1.25, Math.max(0.3, (nuance.gainMod || 1.0)));
      gainNode.gain.setValueAtTime(0.001, this.audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(targetGain, this.audioCtx.currentTime + 0.02);

      // Keep native neural playback rate clean for pristine acoustic fidelity
      source.playbackRate.value = 1.0;

      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);

      let ended = false;
      source.onended = () => {
        if (ended) return;
        ended = true;
        this.currentSource = null;
        if (onEnd) onEnd();
      };

      this.currentSource = source;
      this.gainNode = gainNode;
      if (onStart) onStart();
      source.start(0);

    } catch (err) {
      if (err.message === 'interrupted') return;
      console.warn('Kokoro neural play error:', err);
      if (onError) onError(err);
    }
  }

  stop() {
    this.playToken++; // invalidate pending playbacks
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' });
    }
    if (this.currentSource) {
      try {
        if (this.gainNode && this.audioCtx) {
          this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, this.audioCtx.currentTime);
          this.gainNode.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.015);
        }
        this.currentSource.stop();
      } catch (e) {
        // already stopped
      }
      this.currentSource = null;
      this.gainNode = null;
    }
  }
}


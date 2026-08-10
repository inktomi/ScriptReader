/**
 * Web Speech API Engine (Fallback)
 * Clean standard browser speech synthesis used as an offline/safety fallback.
 */

export class WebSpeechEngine {
  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    this.voices = [];
    this.currentUtterance = null;
    this.watchdogTimer = null;
    this.isPaused = false;
    this.initialized = false;
    this.voiceAssignmentCache = new Map();
  }

  async init() {
    if (!this.synth) return false;

    await this.loadVoices();
    if (this.synth.onvoiceschanged !== undefined) {
      this.synth.onvoiceschanged = () => this.loadVoices();
    }

    this.initialized = true;
    return true;
  }

  loadVoices() {
    return new Promise((resolve) => {
      let v = this.synth ? this.synth.getVoices() : [];
      if (v.length > 0) {
        this.voices = v;
        this.voiceAssignmentCache.clear();
        resolve(v);
        return;
      }
      const timeout = setTimeout(() => {
        this.voices = this.synth ? this.synth.getVoices() : [];
        this.voiceAssignmentCache.clear();
        resolve(this.voices);
      }, 300);

      if (this.synth) {
        this.synth.onvoiceschanged = () => {
          clearTimeout(timeout);
          this.voices = this.synth.getVoices();
          this.voiceAssignmentCache.clear();
          resolve(this.voices);
        };
      }
    });
  }

  findMatchingSystemVoice(voiceProfile) {
    if (!this.voices || this.voices.length === 0) {
      this.voices = this.synth ? this.synth.getVoices() : [];
    }
    if (this.voices.length === 0) return null;

    const profileId = voiceProfile?.id || voiceProfile?.name || 'default';
    if (this.voiceAssignmentCache.has(profileId)) {
      return this.voiceAssignmentCache.get(profileId);
    }

    const isBritish = voiceProfile?.accent === 'British';
    const isFemale = voiceProfile?.sex === 'Female';

    // Find English voices
    const enVoices = this.voices.filter(v => (v.lang || '').toLowerCase().startsWith('en'));
    const pool = enVoices.length > 0 ? enVoices : this.voices;

    // Best effort match
    let matched = pool.find(v => {
      const name = v.name.toLowerCase();
      if (isBritish && (v.lang.includes('GB') || name.includes('uk') || name.includes('british'))) return true;
      if (isFemale && (name.includes('female') || name.includes('samantha') || name.includes('karen') || name.includes('zira') || name.includes('siri'))) return true;
      return false;
    }) || pool[0];

    this.voiceAssignmentCache.set(profileId, matched);
    return matched;
  }

  speakLine({
    text,
    voiceProfile,
    nuance = {},
    speedMultiplier = 1.0,
    onStart,
    onEnd,
    onError
  }) {
    if (!this.synth) {
      if (onError) onError(new Error('Web Speech API is not supported in this browser.'));
      return;
    }

    this.stop();

    const spokenText = nuance.cleanSpeech || text;
    if (!spokenText.trim()) {
      if (onEnd) onEnd();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(spokenText);
    const systemVoice = this.findMatchingSystemVoice(voiceProfile);
    if (systemVoice) {
      utterance.voice = systemVoice;
      utterance.lang = systemVoice.lang;
    }

    utterance.rate = Math.min(1.5, Math.max(0.75, speedMultiplier));
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    let hasEnded = false;
    const finishLine = () => {
      if (hasEnded) return;
      hasEnded = true;
      this.clearWatchdog();
      this.currentUtterance = null;
      if (onEnd) onEnd();
    };

    utterance.onstart = () => {
      this.currentUtterance = utterance;
      if (onStart) onStart();

      const wordCount = spokenText.split(/\s+/).length || 1;
      const estimatedSec = Math.max(8.0, (wordCount / (1.2 * utterance.rate)) + 6.0);
      this.watchdogTimer = setTimeout(() => {
        if (!hasEnded && this.synth && this.synth.speaking) {
          if (this.synth) this.synth.cancel();
          finishLine();
        }
      }, estimatedSec * 1000);
    };

    utterance.onend = () => {
      finishLine();
    };

    utterance.onerror = (e) => {
      if (e.error === 'canceled' || e.error === 'interrupted') {
        finishLine();
        return;
      }
      if (onError) onError(e);
      else finishLine();
    };

    if (this.synth.paused) {
      this.synth.resume();
    }

    this.synth.speak(utterance);
  }

  clearWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  pause() {
    this.clearWatchdog();
    if (this.synth && this.synth.speaking) {
      this.synth.pause();
      this.isPaused = true;
    }
  }

  resume() {
    if (this.synth && this.isPaused) {
      this.synth.resume();
      this.isPaused = false;
    }
  }

  stop() {
    this.clearWatchdog();
    if (this.synth) {
      this.synth.cancel();
      this.currentUtterance = null;
      this.isPaused = false;
    }
  }
}

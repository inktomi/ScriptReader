import { WebSpeechEngine } from './web-speech-engine.js';
import { KokoroNeuralEngine } from './kokoro-engine.js';
import { ModelCacheManager, DEFAULT_MODEL_ID } from './model-cache-manager.js';
import { getVoiceById } from './voice-catalog.js';

export const ENGINE_TYPES = {
  KOKORO_NEURAL: 'kokoro_neural',
  WEB_SPEECH: 'web_speech'
};

export const PLAYBACK_STATES = {
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
  BUFFERING: 'buffering'
};

export const PACING_MODES = {
  NATURAL: 'natural',   // Authentic human table read
  DRAMATIC: 'dramatic', // Rich theatrical breathing and tension
  SNAPPY: 'snappy'      // Rapid rehearsal readthrough
};

export class ScreenplayAudioManager {
  constructor() {
    this.webSpeechEngine = new WebSpeechEngine();
    this.kokoroEngine = new KokoroNeuralEngine();
    this.modelCacheManager = ModelCacheManager;
    this.activeEngineType = ENGINE_TYPES.KOKORO_NEURAL;

    this.scriptElements = [];
    this.characterAssignments = new Map(); // characterName -> { voiceId, pitchOffset, speedMultiplier }
    this.narratorVoiceId = 'bm_george';

    this.currentIndex = 0;
    this.playbackState = PLAYBACK_STATES.IDLE;
    this.pacingMode = PACING_MODES.NATURAL;
    this.masterSpeed = 1.0;
    this.volume = 1.0;
    this.isMuted = false;

    this.playbackToken = 0;
    this.currentTimeout = null;
    this.visualizer = null;
    this.listeners = new Set();
  }

  async init() {
    await this.webSpeechEngine.init();
    // Auto-initialize Kokoro neural model and local caching in background
    this.kokoroEngine.init().catch(err => {
      console.warn('Kokoro background preload notice:', err);
    });
  }

  async getCacheStatus() {
    return await ModelCacheManager.getModelCacheStatus(DEFAULT_MODEL_ID);
  }

  setVisualizer(visualizer) {
    this.visualizer = visualizer;
  }

  setPacingMode(pacingMode) {
    this.pacingMode = pacingMode || PACING_MODES.NATURAL;
    this.emit('pacingChange', { pacingMode: this.pacingMode });
  }

  setEngineType(engineType) {
    if (engineType === this.activeEngineType) return;
    this.stop();
    this.activeEngineType = engineType;
    this.emit('engineChange', { engineType });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(eventType, data) {
    for (const listener of this.listeners) {
      try {
        listener(eventType, data);
      } catch (err) {
        console.error('Audio manager listener error:', err);
      }
    }
  }

  setScript(elements, characterMap = new Map(), startIndex = 0) {
    this.stop();
    this.scriptElements = elements || [];
    this.characterAssignments = characterMap;
    this.currentIndex = Math.max(0, Math.min(this.scriptElements.length - 1, startIndex || 0));
    this.emit('scriptLoaded', { totalLines: this.scriptElements.length, currentIndex: this.currentIndex });

    // Pre-warm audio lookahead if Kokoro is active
    if (this.activeEngineType === ENGINE_TYPES.KOKORO_NEURAL && this.kokoroEngine.isReady && this.scriptElements.length > 0) {
      this.triggerLookahead(this.currentIndex - 1, 4);
    }
  }

  setVoiceAssignment(characterName, assignment) {
    this.characterAssignments.set(characterName.toUpperCase().trim(), assignment);
  }

  setNarratorVoice(voiceId) {
    this.narratorVoiceId = voiceId;
  }

  setMasterSpeed(speed) {
    this.masterSpeed = Math.min(2.0, Math.max(0.5, speed));
    this.emit('speedChange', { speed: this.masterSpeed });
  }

  setVolume(volume) {
    this.volume = Math.min(1.0, Math.max(0, volume));
    this.emit('volumeChange', { volume: this.volume });
  }

  getVoiceProfileForCharacter(characterName) {
    const cleanName = (characterName || '').toUpperCase().trim();
    if (cleanName === 'NARRATOR' || cleanName.includes('SCENE') || cleanName === 'STAGE') {
      return getVoiceById(this.narratorVoiceId || 'bm_george');
    }

    const assignment = this.characterAssignments.get(cleanName);
    if (assignment && assignment.voiceId) {
      return getVoiceById(assignment.voiceId);
    }
    return getVoiceById('am_adam');
  }

  getCharacterSettings(characterName) {
    const cleanName = (characterName || '').toUpperCase().trim();
    const assignment = this.characterAssignments.get(cleanName);
    return {
      pitchOffset: assignment ? (assignment.pitchOffset || 0) : 0,
      speedMultiplier: assignment ? (assignment.speedMultiplier || 1.0) : 1.0
    };
  }

  /**
   * Preview a voice profile in the Cast Studio
   */
  async previewVoice(voiceId, sampleText = null, pitchOffset = 0, speedMultiplier = 1.0) {
    this.stop(); // stop active playback
    const profile = getVoiceById(voiceId);
    const text = sampleText || profile.sampleLine;
    const nuance = {
      cleanSpeech: text,
      pitchMod: 1.0,
      rateMod: 1.0,
      gainMod: 1.0,
      badgeColor: '#F59E0B'
    };

    if (this.visualizer) {
      this.visualizer.setSpeaking(true, { badgeColor: profile.avatarBg.includes('#') ? '#F59E0B' : '#06B6D4' });
    }

    // Auto-init Kokoro if needed
    if (!this.kokoroEngine.isReady && !this.kokoroEngine.isLoading) {
      try {
        await this.kokoroEngine.init();
      } catch (e) {
        console.warn('Kokoro init fallback for preview:', e);
      }
    }

    if (this.activeEngineType === ENGINE_TYPES.KOKORO_NEURAL && this.kokoroEngine.isReady) {
      try {
        await this.kokoroEngine.playLine({
          text,
          voiceProfile: profile,
          nuance,
          pitchOffset,
          speedMultiplier: speedMultiplier * this.masterSpeed,
          onEnd: () => {
            if (this.visualizer) this.visualizer.setSpeaking(false);
          }
        });
        return;
      } catch (err) {
        console.warn('Kokoro preview failed, fallback to Web Speech:', err);
      }
    }

    // Fallback
    this.webSpeechEngine.speakLine({
      text,
      voiceProfile: profile,
      nuance,
      speedMultiplier: speedMultiplier * this.masterSpeed,
      onEnd: () => {
        if (this.visualizer) this.visualizer.setSpeaking(false);
      }
    });
  }

  /**
   * Start or Resume reading
   */
  async play() {
    if (this.scriptElements.length === 0) return;
    if (this.playbackState === PLAYBACK_STATES.PLAYING) return;

    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }

    this.playbackToken++;
    this.playbackState = PLAYBACK_STATES.PLAYING;
    this.emit('stateChange', { state: this.playbackState });

    // If Kokoro is not ready yet, initialize it
    if (this.activeEngineType === ENGINE_TYPES.KOKORO_NEURAL && !this.kokoroEngine.isReady && !this.kokoroEngine.isLoading) {
      try {
        await this.kokoroEngine.init();
      } catch (e) {
        console.warn('Kokoro play initialization fallback:', e);
      }
    }

    if (this.activeEngineType === ENGINE_TYPES.WEB_SPEECH) {
      this.webSpeechEngine.resume();
    }
    this.playCurrentLine(true);
  }

  pause() {
    this.playbackToken++;
    this.playbackState = PLAYBACK_STATES.PAUSED;
    this.emit('stateChange', { state: this.playbackState });

    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }

    this.webSpeechEngine.stop();
    this.kokoroEngine.stop();

    if (this.visualizer) {
      this.visualizer.setSpeaking(false);
    }
  }

  stop() {
    this.playbackToken++;
    this.playbackState = PLAYBACK_STATES.IDLE;
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }

    this.webSpeechEngine.stop();
    this.kokoroEngine.stop();

    if (this.visualizer) {
      this.visualizer.stop();
    }

    this.emit('stateChange', { state: this.playbackState });
  }

  seek(index) {
    const target = Math.max(0, Math.min(this.scriptElements.length - 1, index));
    const wasPlaying = this.playbackState === PLAYBACK_STATES.PLAYING;

    this.stop();
    this.currentIndex = target;
    this.emit('lineChange', { index: this.currentIndex, element: this.scriptElements[this.currentIndex] });

    // Pre-buffer the newly selected line immediately
    this.triggerLookahead(this.currentIndex - 1, 4);

    if (wasPlaying) {
      this.play();
    }
  }

  skipNext() {
    if (this.currentIndex < this.scriptElements.length - 1) {
      this.seek(this.currentIndex + 1);
    }
  }

  skipPrev() {
    if (this.currentIndex > 0) {
      this.seek(this.currentIndex - 1);
    }
  }

  /**
   * Pre-fetches upcoming lines into neural audio cache for seamless playback
   */
  triggerLookahead(fromIndex, count = 4) {
    if (this.activeEngineType !== ENGINE_TYPES.KOKORO_NEURAL || !this.kokoroEngine.isReady) return;

    const items = [];
    for (let i = fromIndex + 1; i <= Math.min(this.scriptElements.length - 1, fromIndex + count); i++) {
      const elem = this.scriptElements[i];
      if (!elem) continue;
      const voiceProfile = this.getVoiceProfileForCharacter(elem.character);
      const charSettings = this.getCharacterSettings(elem.character);
      items.push({
        text: elem.text,
        voiceProfile,
        nuance: elem.nuance || {},
        speedMultiplier: charSettings.speedMultiplier * this.masterSpeed
      });
    }

    if (items.length > 0) {
      this.kokoroEngine.preBufferUpcoming(items);
    }
  }

  /**
   * Calculates natural theatrical cue handoff gap between lines based on pacing mode
   */
  computeCueHandOffDelay(currentElem, nextElem) {
    if (!nextElem) return 0;

    let pacingFactor = 1.0;
    if (this.pacingMode === PACING_MODES.DRAMATIC) pacingFactor = 1.40;
    else if (this.pacingMode === PACING_MODES.SNAPPY) pacingFactor = 0.65;

    let baseDelay = 220;

    // Explicit dramatic beat (e.g. (beat), (pause))
    if (nextElem.nuance && nextElem.nuance.isBeat) {
      baseDelay = 800;
    }
    // Scene heading: breathing room to let audience visualize new location
    else if (currentElem.type === 'SCENE_HEADING') {
      baseDelay = 650;
    }
    // Transition (CUT TO / FADE OUT)
    else if (currentElem.type === 'TRANSITION') {
      baseDelay = 500;
    }
    // Action direction to character dialogue
    else if (currentElem.type === 'ACTION' && nextElem.type === 'DIALOGUE') {
      baseDelay = 280;
    }
    // Character dialogue to action direction
    else if (currentElem.type === 'DIALOGUE' && nextElem.type === 'ACTION') {
      baseDelay = 260;
    }
    // Same character continuing dialogue
    else if (currentElem.character === nextElem.character) {
      baseDelay = 160;
    }
    // Dialogue to Dialogue (different characters in table read)
    else if (currentElem.type === 'DIALOGUE' && nextElem.type === 'DIALOGUE') {
      baseDelay = 240;
    }

    return Math.round((baseDelay * pacingFactor) / this.masterSpeed);
  }

  /**
   * Internal line playback pipeline for smooth table reads
   */
  async playCurrentLine(isInitialStart = false) {
    if (this.playbackState !== PLAYBACK_STATES.PLAYING) return;
    if (this.currentIndex >= this.scriptElements.length) {
      this.stop();
      this.currentIndex = 0;
      this.emit('complete', {});
      return;
    }

    const currentLineToken = ++this.playbackToken;
    const currentElement = this.scriptElements[this.currentIndex];
    const voiceProfile = this.getVoiceProfileForCharacter(currentElement.character);
    const charSettings = this.getCharacterSettings(currentElement.character);
    const nuance = currentElement.nuance || {};

    // Trigger lookahead pre-buffering for upcoming lines
    this.triggerLookahead(this.currentIndex, 4);

    // Notify UI active line has started
    this.emit('lineStart', {
      index: this.currentIndex,
      element: currentElement,
      voice: voiceProfile,
      nuance
    });

    if (this.visualizer) {
      this.visualizer.setSpeaking(true, nuance);
    }

    const onLineFinished = () => {
      if (this.playbackToken !== currentLineToken || this.playbackState !== PLAYBACK_STATES.PLAYING) return;

      if (this.visualizer) {
        this.visualizer.setSpeaking(false);
      }

      this.emit('lineEnd', { index: this.currentIndex, element: currentElement });

      const nextElement = this.scriptElements[this.currentIndex + 1];
      const cueDelay = this.computeCueHandOffDelay(currentElement, nextElement);

      if (cueDelay <= 0) {
        this.currentIndex++;
        this.playCurrentLine(false);
      } else {
        this.currentTimeout = setTimeout(() => {
          if (this.playbackToken === currentLineToken && this.playbackState === PLAYBACK_STATES.PLAYING) {
            this.currentIndex++;
            this.playCurrentLine(false);
          }
        }, cueDelay);
      }
    };

    const onError = (err) => {
      console.warn('Audio playback error on line', this.currentIndex, err);
      onLineFinished();
    };

    // Play with chosen speech engine
    if (this.activeEngineType === ENGINE_TYPES.KOKORO_NEURAL && this.kokoroEngine.isReady) {
      try {
        await this.kokoroEngine.playLine({
          text: currentElement.text,
          voiceProfile,
          nuance,
          pitchOffset: charSettings.pitchOffset,
          speedMultiplier: charSettings.speedMultiplier * this.masterSpeed,
          onEnd: onLineFinished,
          onError
        });
      } catch (err) {
        console.warn('Kokoro neural playback error, fallback to browser speech:', err);
        if (this.playbackToken === currentLineToken) {
          this.webSpeechEngine.speakLine({
            text: currentElement.text,
            voiceProfile,
            nuance,
            speedMultiplier: charSettings.speedMultiplier * this.masterSpeed,
            onEnd: onLineFinished,
            onError
          });
        }
      }
    } else {
      this.webSpeechEngine.speakLine({
        text: currentElement.text,
        voiceProfile,
        nuance,
        speedMultiplier: charSettings.speedMultiplier * this.masterSpeed,
        onEnd: onLineFinished,
        onError
      });
    }
  }
}

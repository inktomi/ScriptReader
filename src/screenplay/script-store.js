import { parseFountainScript } from './fountain-parser.js';
import { parsePdfScreenplay } from './pdf-parser.js';
import { SAMPLE_SCRIPTS } from './sample-scripts.js';
import { getSuggestedVoiceForCharacter, getDefaultNarratorVoice } from '../audio/voice-catalog.js';
import {
  generateScriptKey,
  saveScriptCastConfig,
  loadScriptCastConfig,
  saveAppState,
  loadAppState,
  savePlaybackPosition
} from '../utils/storage.js';

export class ScriptStore {
  constructor() {
    this.currentScript = null;
    this.scriptKey = null;
    this.scriptType = 'sample'; // 'sample' | 'custom'
    this.sampleId = null;
    this.customScriptData = null;

    this.castAssignments = new Map(); // characterName -> { voiceId, pitchOffset, speedMultiplier, tonePreset }
    this.narratorVoiceId = 'bm_george';
    this.activeLineIndex = 0;
    this.selectedScene = null;
    this.characterFilter = null;
    this.subscribers = new Set();
    this.savePositionTimeout = null;
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  notify(event, data) {
    for (const cb of this.subscribers) {
      try {
        cb(event, data);
      } catch (err) {
        console.error('Script store subscriber error:', err);
      }
    }
  }

  /**
   * Try restoring the previous session from LocalStorage
   * Returns true if restored, false if no previous session was found
   */
  restoreSavedSession() {
    try {
      const appState = loadAppState();
      if (!appState || !appState.activeScriptKey) return false;

      if (appState.scriptType === 'sample' && appState.sampleId) {
        this.loadSample(appState.sampleId, false);
        return true;
      } else if (appState.scriptType === 'custom' && appState.customScriptData) {
        this.loadFountainText(
          appState.customScriptData.fountainText,
          appState.customScriptData.title || 'Custom Screenplay',
          false
        );
        return true;
      }
      return false;
    } catch (err) {
      console.warn('Could not restore saved session:', err);
      return false;
    }
  }

  /**
   * Loads a pre-packaged sample screenplay
   */
  loadSample(sampleId, resetProgress = false) {
    const sample = SAMPLE_SCRIPTS.find(s => s.id === sampleId) || SAMPLE_SCRIPTS[0];
    const parsed = parseFountainScript(sample.fountainText);
    parsed.id = sample.id;
    parsed.title = sample.title;

    this.setScriptData(parsed, {
      scriptKey: `sample_${sample.id}`,
      scriptType: 'sample',
      sampleId: sample.id,
      resetProgress
    });
  }

  /**
   * Loads a screenplay from a PDF File or Buffer
   */
  async loadPdf(file, onProgress) {
    const parsed = await parsePdfScreenplay(file, onProgress);
    const key = generateScriptKey(parsed);

    this.setScriptData(parsed, {
      scriptKey: key,
      scriptType: 'custom',
      customData: {
        title: parsed.title,
        // Round-tripping through Fountain is how a PDF survives a reload, so
        // anything dropped here is lost for good. Parentheticals were being
        // dropped, which quietly cost every direction-derived performance —
        // and would now cost overlap markings too.
        fountainText: (() => {
          let previousPace = 'natural';
          return parsed.elements.map(e => {
            let out = '';
            if (e.pace && e.pace !== previousPace) {
              out += `\n[[pace: ${e.pace}]]\n`;
              previousPace = e.pace;
            }
            if (e.type === 'DIALOGUE') {
              const dual = e.overlap && e.overlap.mode === 'simultaneous' ? ' ^' : '';
              const paren = e.parenthetical ? `(${e.parenthetical})\n` : '';
              // e.text keeps its raw trailing dash, so interruptions re-derive.
              return `${out}\n${e.characterOriginal || e.character}${dual}\n${paren}${e.text}\n`;
            }
            return `${out}\n${e.text}\n`;
          }).join('');
        })()
      },
      resetProgress: true
    });
  }

  /**
   * Loads a screenplay from Fountain or Text string
   */
  loadFountainText(text, title = 'Custom Screenplay', resetProgress = false) {
    const parsed = parseFountainScript(text);
    if (title && (parsed.title === 'Screenplay' || !parsed.title)) {
      parsed.title = title;
    }
    const key = generateScriptKey(parsed);

    this.setScriptData(parsed, {
      scriptKey: key,
      scriptType: 'custom',
      customData: {
        title: parsed.title,
        fountainText: text
      },
      resetProgress
    });
  }

  /**
   * Sets new script data and resolves voice configuration from LocalStorage or auto-cast
   */
  setScriptData(parsedScript, {
    scriptKey = null,
    scriptType = 'sample',
    sampleId = null,
    customData = null,
    resetProgress = false
  } = {}) {
    this.currentScript = parsedScript;
    this.scriptKey = scriptKey || generateScriptKey(parsedScript);
    this.scriptType = scriptType;
    this.sampleId = sampleId;
    this.customScriptData = customData;
    this.selectedScene = null;
    this.characterFilter = null;
    this.castAssignments.clear();

    // Check if we have saved voice configuration and progress for this script in LocalStorage
    const savedConfig = loadScriptCastConfig(this.scriptKey);
    let isConfigured = false;

    if (savedConfig && savedConfig.configured) {
      isConfigured = true;
      this.narratorVoiceId = savedConfig.narratorVoiceId || getDefaultNarratorVoice().id;
      
      // Load saved character assignments
      if (savedConfig.castAssignments) {
        for (const [charKey, assignment] of savedConfig.castAssignments.entries()) {
          this.castAssignments.set(charKey, assignment);
        }
      }

      // Check if any new characters were detected that weren't in saved config
      const usedVoices = new Set([this.narratorVoiceId]);
      for (const assignment of this.castAssignments.values()) {
        if (assignment.voiceId) usedVoices.add(assignment.voiceId);
      }

      for (const char of parsedScript.characters) {
        const key = char.name.toUpperCase().trim();
        if (!this.castAssignments.has(key)) {
          const suggestedVoiceId = getSuggestedVoiceForCharacter(char.name, {
            sampleLine: char.sampleLine,
            usedVoices
          });
          usedVoices.add(suggestedVoiceId);
          this.castAssignments.set(key, {
            voiceId: suggestedVoiceId,
            pitchOffset: 0,
            speedMultiplier: 1.0,
            tonePreset: 'natural'
          });
        }
      }

      // Set playback line from saved session or reset
      if (resetProgress) {
        this.activeLineIndex = 0;
      } else {
        const savedIndex = savedConfig.activeLineIndex || 0;
        this.activeLineIndex = Math.min(Math.max(0, savedIndex), Math.max(0, parsedScript.elements.length - 1));
      }
    } else {
      // First time loading this script: Auto-assign smart unique voices for each detected character
      isConfigured = false;
      this.narratorVoiceId = getDefaultNarratorVoice().id;
      const usedVoices = new Set([this.narratorVoiceId]);

      for (const char of parsedScript.characters) {
        const suggestedVoiceId = getSuggestedVoiceForCharacter(char.name, {
          sampleLine: char.sampleLine,
          usedVoices
        });
        usedVoices.add(suggestedVoiceId);
        this.castAssignments.set(char.name.toUpperCase().trim(), {
          voiceId: suggestedVoiceId,
          pitchOffset: 0,
          speedMultiplier: 1.0,
          tonePreset: 'natural'
        });
      }

      this.activeLineIndex = 0;

      // Save initial auto-assigned configuration
      this.saveCurrentState();
    }

    // Save global active app state
    saveAppState({
      activeScriptKey: this.scriptKey,
      scriptType: this.scriptType,
      sampleId: this.sampleId,
      customScriptData: this.customScriptData,
      activeLineIndex: this.activeLineIndex
    });

    this.notify('scriptLoaded', {
      script: this.currentScript,
      characters: this.currentScript.characters,
      scenes: this.currentScript.scenes,
      totalLines: this.currentScript.elements.length,
      scriptKey: this.scriptKey,
      isConfigured,
      activeLineIndex: this.activeLineIndex
    });
  }

  /**
   * Save current voice setup and line index to LocalStorage
   */
  saveCurrentState() {
    if (!this.scriptKey || !this.currentScript) return;

    saveScriptCastConfig(this.scriptKey, {
      narratorVoiceId: this.narratorVoiceId,
      castAssignments: this.castAssignments,
      activeLineIndex: this.activeLineIndex,
      scriptTitle: this.currentScript.title
    });

    saveAppState({
      activeScriptKey: this.scriptKey,
      scriptType: this.scriptType,
      sampleId: this.sampleId,
      customScriptData: this.customScriptData,
      activeLineIndex: this.activeLineIndex
    });
  }

  updateCharacterVoice(characterName, { voiceId, pitchOffset, speedMultiplier, tonePreset }) {
    const key = characterName.toUpperCase().trim();
    const existing = this.castAssignments.get(key) || { voiceId: 'am_adam', pitchOffset: 0, speedMultiplier: 1.0, tonePreset: 'natural' };
    
    this.castAssignments.set(key, {
      voiceId: voiceId !== undefined ? voiceId : existing.voiceId,
      pitchOffset: pitchOffset !== undefined ? pitchOffset : existing.pitchOffset,
      speedMultiplier: speedMultiplier !== undefined ? speedMultiplier : existing.speedMultiplier,
      tonePreset: tonePreset !== undefined ? tonePreset : (existing.tonePreset || 'natural')
    });

    this.saveCurrentState();

    this.notify('castUpdated', {
      character: key,
      assignment: this.castAssignments.get(key)
    });
  }

  updateNarratorVoice(voiceId) {
    this.narratorVoiceId = voiceId;
    this.saveCurrentState();
    this.notify('narratorUpdated', { voiceId });
  }

  setActiveLine(index) {
    if (!this.currentScript || !this.currentScript.elements[index]) return;
    this.activeLineIndex = index;

    // Debounce save playback position to avoid excessive storage writes during fast reading
    if (this.savePositionTimeout) clearTimeout(this.savePositionTimeout);
    this.savePositionTimeout = setTimeout(() => {
      if (this.scriptKey) {
        savePlaybackPosition(this.scriptKey, index);
      }
    }, 400);

    this.notify('activeLineChanged', {
      index,
      element: this.currentScript.elements[index]
    });
  }

  filterByCharacter(characterName) {
    this.characterFilter = characterName ? characterName.toUpperCase().trim() : null;
    this.notify('filterChanged', { characterFilter: this.characterFilter });
  }

  jumpToScene(sceneNumber) {
    if (!this.currentScript) return;
    const scene = this.currentScript.scenes.find(s => s.number === sceneNumber);
    if (scene) {
      this.setActiveLine(scene.lineIndex);
      return scene.lineIndex;
    }
    return 0;
  }
}

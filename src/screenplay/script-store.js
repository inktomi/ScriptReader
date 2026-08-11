import { parseFountainScript } from './fountain-parser.js';
import { SAMPLE_SCRIPTS } from './sample-scripts.js';
import { ENGINE_IDS as ENGINE_ID_MAP } from '../audio/engine-contract.js';
import {
  getSuggestedVoiceForCharacter,
  getDefaultNarratorVoice,
  makeDefaultAssignment,
  isCastable,
  mapVoiceAcrossEngines,
  DEFAULT_NARRATOR_VOICE_ID
} from '../audio/voice-catalog.js';
import {
  generateScriptKey,
  generateLegacyScriptKey,
  saveScriptCastConfig,
  loadScriptCastConfig,
  saveAppState,
  loadAppState,
  savePlaybackPosition,
  backupCastConfig,
  CAST_VERSION
} from '../utils/storage.js';

export class ScriptStore {
  constructor() {
    this.currentScript = null;
    this.scriptKey = null;
    this.scriptType = 'sample'; // 'sample' | 'custom'
    this.sampleId = null;
    this.customScriptData = null;

    this.castAssignments = new Map(); // characterName -> { voiceId, pitchOffset, speedMultiplier, tonePreset }
    this.narratorVoiceId = DEFAULT_NARRATOR_VOICE_ID;
    this.narratorVoiceIds = { [ENGINE_ID_MAP.KOKORO]: DEFAULT_NARRATOR_VOICE_ID };
    // Set by the cast migration, consumed once by the UI to offer an undo.
    this.pendingCastMigration = null;
    // A weak legacy key cannot prove that its config belongs to a newly
    // imported script. The UI offers this candidate explicitly instead of
    // either losing it silently or applying another script's cast by mistake.
    this.pendingLegacyConfig = null;
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
          false,
          appState.activeScriptKey
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
    const { parsePdfScreenplay } = await import('./pdf-parser.js');
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
  loadFountainText(
    text,
    title = 'Custom Screenplay',
    resetProgress = false,
    legacyConfigKey = null
  ) {
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
      resetProgress,
      legacyConfigKey
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
    resetProgress = false,
    legacyConfigKey = null
  } = {}) {
    if (this.savePositionTimeout) {
      clearTimeout(this.savePositionTimeout);
      this.savePositionTimeout = null;
    }

    this.currentScript = parsedScript;
    this.scriptKey = scriptKey || generateScriptKey(parsedScript);
    this.scriptType = scriptType;
    this.sampleId = sampleId;
    this.customScriptData = customData;
    this.selectedScene = null;
    this.characterFilter = null;
    this.castAssignments.clear();
    this.pendingLegacyConfig = null;

    // Check if we have saved voice configuration and progress for this script in LocalStorage
    const expectedLegacyKey = scriptType === 'custom'
      ? generateLegacyScriptKey(parsedScript)
      : null;
    const useExplicitLegacyConfig = Boolean(
      legacyConfigKey
      && legacyConfigKey === expectedLegacyKey
      && legacyConfigKey !== this.scriptKey
    );
    let savedConfig = useExplicitLegacyConfig
      ? loadScriptCastConfig(legacyConfigKey)
      : loadScriptCastConfig(this.scriptKey);
    let migratedLegacyConfig = false;
    if (useExplicitLegacyConfig) {
      migratedLegacyConfig = !!savedConfig;
    } else if (!savedConfig && expectedLegacyKey && expectedLegacyKey !== this.scriptKey) {
      const legacyCandidate = loadScriptCastConfig(expectedLegacyKey);
      if (legacyCandidate && legacyCandidate.configured) {
        this.pendingLegacyConfig = {
          legacyKey: expectedLegacyKey,
          scriptKey: this.scriptKey,
          scriptTitle: parsedScript.title
        };
      }
    }
    if (migratedLegacyConfig) {
      saveScriptCastConfig(this.scriptKey, {
        narratorVoiceId: savedConfig.narratorVoiceId,
        narratorVoiceIds: savedConfig.narratorVoiceIds,
        castAssignments: savedConfig.castAssignments,
        activeLineIndex: savedConfig.activeLineIndex,
        scriptTitle: parsedScript.title,
        castVersion: savedConfig.castVersion
      });
    }
    let isConfigured = false;

    if (savedConfig && savedConfig.configured) {
      isConfigured = true;
      this.narratorVoiceIds = { ...(savedConfig.narratorVoiceIds || {}) };
      this.narratorVoiceId = this.narratorVoiceIds[ENGINE_ID_MAP.KOKORO]
        || getDefaultNarratorVoice().id;
      if (!this.narratorVoiceIds[ENGINE_ID_MAP.KOKORO]) {
        this.narratorVoiceIds[ENGINE_ID_MAP.KOKORO] = this.narratorVoiceId;
      }
      
      // Load saved character assignments
      if (savedConfig.castAssignments) {
        for (const [charKey, assignment] of savedConfig.castAssignments.entries()) {
          this.castAssignments.set(charKey, assignment);
        }
      }

      // Casts saved before voices were ranked may hold voices the auto-caster
      // would never pick today.
      if ((savedConfig.castVersion || 1) < CAST_VERSION) {
        this._migrateCastToCurrentVersion(parsedScript);
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
          this.castAssignments.set(key, makeDefaultAssignment(suggestedVoiceId));
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
      this.narratorVoiceIds = { [ENGINE_ID_MAP.KOKORO]: this.narratorVoiceId };
      const usedVoices = new Set([this.narratorVoiceId]);

      for (const char of parsedScript.characters) {
        const suggestedVoiceId = getSuggestedVoiceForCharacter(char.name, {
          sampleLine: char.sampleLine,
          usedVoices
        });
        usedVoices.add(suggestedVoiceId);
        this.castAssignments.set(char.name.toUpperCase().trim(), makeDefaultAssignment(suggestedVoiceId));
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

    if (migratedLegacyConfig) this.saveCurrentState();

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
      narratorVoiceIds: this.narratorVoiceIds,
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

  /**
   * Lift a pre-ranking cast onto voices that clear the quality floor.
   *
   * Only assignments that are *both* automatic and below the floor are touched.
   * Two deliberate omissions:
   *
   *  - A voice someone chose is left alone even if it grades badly. Nothing in v1
   *    data distinguishes "auto-assigned" from "chosen" directly, so a moved
   *    slider or a tone chip is taken as evidence somebody cared. Silently
   *    replacing a villain deliberately cast as Onyx would be worse than leaving
   *    a rough voice in place.
   *  - An automatic assignment that already clears the floor is left alone too.
   *    It is not the defect, and re-casting it would churn a listener's familiar
   *    cast for no audible gain.
   *
   * Characters are walked in the parser's order — descending line count — so the
   * best remaining voices go to the largest parts.
   *
   * Records `pendingCastMigration` for the UI to offer an undo; the backup it
   * refers to is written before anything changes.
   */
  _migrateCastToCurrentVersion(parsedScript) {
    backupCastConfig(this.scriptKey);

    const isDeliberate = (a) =>
      a.auto === false ||
      (a.pitchOffset || 0) !== 0 ||
      (a.speedMultiplier || 1.0) !== 1.0 ||
      (a.tonePreset && a.tonePreset !== 'natural');

    const changed = [];

    // Only upgrade the narrator if it is still literally the old default; anything
    // else is a choice.
    if (this.narratorVoiceId === 'bm_george') {
      this.narratorVoiceId = DEFAULT_NARRATOR_VOICE_ID;
      this.narratorVoiceIds = {
        ...this.narratorVoiceIds,
        [ENGINE_ID_MAP.KOKORO]: DEFAULT_NARRATOR_VOICE_ID
      };
      changed.push('NARRATOR');
    }

    // Reserve every voice that is staying put, so a re-cast cannot collide with
    // one and produce two characters sharing a voice.
    const usedVoices = new Set([this.narratorVoiceId]);
    for (const assignment of this.castAssignments.values()) {
      if (!assignment.voiceId) continue;
      if (isDeliberate(assignment) || isCastable(assignment.voiceId)) {
        usedVoices.add(assignment.voiceId);
      }
    }

    for (const char of parsedScript.characters) {
      const key = char.name.toUpperCase().trim();
      const existing = this.castAssignments.get(key);
      if (!existing || isDeliberate(existing) || isCastable(existing.voiceId)) continue;

      const replacement = getSuggestedVoiceForCharacter(char.name, {
        sampleLine: char.sampleLine,
        usedVoices
      });
      usedVoices.add(replacement);
      this.castAssignments.set(key, { ...existing, voiceId: replacement, auto: true });
      changed.push(key);
    }

    this.pendingCastMigration = changed.length > 0
      ? { scriptKey: this.scriptKey, changed, count: changed.length }
      : null;

    // Stamp the new version even when nothing changed, so this does not re-run
    // on every load of an already-fine cast.
    this.saveCurrentState();
  }

  updateCharacterVoice(characterName, {
    voiceId,
    voiceIds: incomingVoiceIds,
    pitchOffset,
    speedMultiplier,
    tonePreset,
    direction,
    engineId,
    deferRender = false
  }) {
    const key = characterName.toUpperCase().trim();
    // This runs for slider drags too, so a character with no assignment yet had
    // `am_adam` — the worst-graded voice in the set — written to localStorage
    // simply because someone nudged their pitch.
    const existing = this.castAssignments.get(key) || makeDefaultAssignment();
    
    // A voice choice belongs to the engine it was made under. Writing it into
    // that engine's slot is what lets a listener keep a Kokoro cast and an OpenAI
    // cast for the same script and switch between them without losing either.
    const voiceIds = { ...(existing.voiceIds || {}), ...(incomingVoiceIds || {}) };
    if (voiceId !== undefined && engineId) voiceIds[engineId] = voiceId;

    this.castAssignments.set(key, {
      // The legacy flat field tracks the local engine, which is what saved
      // configs and any older code still expect to find here.
      voiceId: (voiceId !== undefined && (!engineId || engineId === ENGINE_ID_MAP.KOKORO))
        ? voiceId
        : existing.voiceId,
      voiceIds,
      direction: direction !== undefined ? direction : (existing.direction || ''),
      pitchOffset: pitchOffset !== undefined ? pitchOffset : existing.pitchOffset,
      speedMultiplier: speedMultiplier !== undefined ? speedMultiplier : existing.speedMultiplier,
      tonePreset: tonePreset !== undefined ? tonePreset : (existing.tonePreset || 'natural'),
      // Every path into here is a human touching a control, so this assignment
      // is now a decision. The cast migration reads this to know what it may
      // safely re-cast and what it must leave alone.
      auto: false
    });

    this.saveCurrentState();

    this.notify('castUpdated', {
      character: key,
      assignment: this.castAssignments.get(key),
      deferRender
    });
  }

  getNarratorVoice(engineId = ENGINE_ID_MAP.KOKORO) {
    return this.narratorVoiceIds[engineId] || this.narratorVoiceId;
  }

  updateNarratorVoice(voiceId, engineId = ENGINE_ID_MAP.KOKORO) {
    this.narratorVoiceIds = { ...this.narratorVoiceIds, [engineId]: voiceId };
    if (engineId === ENGINE_ID_MAP.KOKORO) this.narratorVoiceId = voiceId;
    this.saveCurrentState();
    this.notify('narratorUpdated', { voiceId, engineId });
  }

  updateCast({ narratorVoiceId, narratorEngineId, castAssignments }) {
    this.narratorVoiceIds = {
      ...this.narratorVoiceIds,
      [narratorEngineId]: narratorVoiceId
    };
    if (narratorEngineId === ENGINE_ID_MAP.KOKORO) {
      this.narratorVoiceId = narratorVoiceId;
    }
    this.castAssignments = new Map(
      Array.from(castAssignments, ([name, assignment]) => [name, { ...assignment }])
    );
    this.saveCurrentState();
    this.notify('castUpdated', { bulk: true });
    this.notify('narratorUpdated', { voiceId: narratorVoiceId, engineId: narratorEngineId });
  }

  autoCastCurrentScript(engineId = ENGINE_ID_MAP.KOKORO) {
    if (!this.currentScript) return;

    const localNarrator = getDefaultNarratorVoice().id;
    const activeNarrator = engineId === ENGINE_ID_MAP.KOKORO
      ? localNarrator
      : mapVoiceAcrossEngines(localNarrator, engineId);
    this.narratorVoiceIds = {
      ...this.narratorVoiceIds,
      [engineId]: activeNarrator
    };
    if (engineId === ENGINE_ID_MAP.KOKORO) this.narratorVoiceId = localNarrator;

    const usedLocalVoices = new Set([localNarrator]);
    const usedEngineVoices = new Set([activeNarrator]);
    const nextAssignments = new Map();
    for (const char of this.currentScript.characters) {
      const localVoiceId = getSuggestedVoiceForCharacter(char.name, {
        sampleLine: char.sampleLine,
        usedVoices: usedLocalVoices
      });
      usedLocalVoices.add(localVoiceId);
      const activeVoiceId = engineId === ENGINE_ID_MAP.KOKORO
        ? localVoiceId
        : mapVoiceAcrossEngines(localVoiceId, engineId, usedEngineVoices);
      usedEngineVoices.add(activeVoiceId);

      const key = char.name.toUpperCase().trim();
      const existing = this.castAssignments.get(key) || makeDefaultAssignment(localVoiceId);
      nextAssignments.set(key, {
        ...existing,
        voiceId: engineId === ENGINE_ID_MAP.KOKORO ? activeVoiceId : existing.voiceId,
        voiceIds: { ...(existing.voiceIds || {}), [engineId]: activeVoiceId },
        pitchOffset: 0,
        speedMultiplier: 1.0,
        tonePreset: 'natural',
        auto: true
      });
    }
    this.castAssignments = nextAssignments;
    this.saveCurrentState();
    this.notify('castUpdated', { bulk: true, autoCast: true });
    this.notify('narratorUpdated', {
      voiceId: activeNarrator,
      engineId
    });
  }

  setActiveLine(index) {
    if (!this.currentScript || !this.currentScript.elements[index]) return;
    this.activeLineIndex = index;

    // Debounce save playback position to avoid excessive storage writes during fast reading
    if (this.savePositionTimeout) clearTimeout(this.savePositionTimeout);
    const scriptKey = this.scriptKey;
    this.savePositionTimeout = setTimeout(() => {
      if (scriptKey) savePlaybackPosition(scriptKey, index);
      this.savePositionTimeout = null;
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

/**
 * Storage Utility for ScriptReader Pro
 * Handles LocalStorage persistence for:
 * - Script character voice assignments (voiceId, pitch, speed, tone)
 * - Narrator voice selection
 * - Playback progress (active line index)
 * - Saved custom and sample script state
 */

const STORAGE_PREFIX = 'scriptreader_';
const APP_STATE_KEY = `${STORAGE_PREFIX}app_state_v2`;
const CAST_PREFIX = `${STORAGE_PREFIX}cast_`;

/**
 * Generate a consistent, unique key for a script
 */
export function generateScriptKey(script) {
  if (!script) return 'default';
  if (script.id) {
    return `sample_${script.id}`;
  }
  const cleanTitle = (script.title || 'untitled').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const signature = (script.elements && script.elements[0] ? script.elements[0].text.substring(0, 30) : '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  return `custom_${cleanTitle}_${signature}`;
}

/**
 * Save character voice configuration and line position for a specific script
 */
export function saveScriptCastConfig(scriptKey, { narratorVoiceId, castAssignments, activeLineIndex = 0, scriptTitle = '' }) {
  try {
    const assignmentsObj = {};
    if (castAssignments instanceof Map) {
      for (const [charName, assignment] of castAssignments.entries()) {
        assignmentsObj[charName] = assignment;
      }
    } else if (typeof castAssignments === 'object' && castAssignments !== null) {
      Object.assign(assignmentsObj, castAssignments);
    }

    const payload = {
      narratorVoiceId,
      castAssignments: assignmentsObj,
      activeLineIndex,
      scriptTitle,
      configured: true,
      updatedAt: Date.now()
    };

    localStorage.setItem(`${CAST_PREFIX}${scriptKey}`, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn('Could not save script cast config to LocalStorage:', err);
    return false;
  }
}

/**
 * Load character voice configuration for a specific script
 */
export function loadScriptCastConfig(scriptKey) {
  try {
    const raw = localStorage.getItem(`${CAST_PREFIX}${scriptKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);

    // Convert castAssignments object back to Map for internal ScriptStore usage
    const castMap = new Map();
    if (parsed.castAssignments && typeof parsed.castAssignments === 'object') {
      for (const [charName, assignment] of Object.entries(parsed.castAssignments)) {
        castMap.set(charName.toUpperCase().trim(), assignment);
      }
    }

    return {
      narratorVoiceId: parsed.narratorVoiceId || 'bm_george',
      castAssignments: castMap,
      activeLineIndex: typeof parsed.activeLineIndex === 'number' ? parsed.activeLineIndex : 0,
      configured: Boolean(parsed.configured),
      updatedAt: parsed.updatedAt || 0
    };
  } catch (err) {
    console.warn('Could not load script cast config from LocalStorage:', err);
    return null;
  }
}

/**
 * Check if the user has already configured voices for this script
 */
export function hasConfiguredScript(scriptKey) {
  const config = loadScriptCastConfig(scriptKey);
  return Boolean(config && config.configured);
}

/**
 * Save current global application state (active script and playback location)
 */
export function saveAppState({ activeScriptKey, scriptType, sampleId, customScriptData, activeLineIndex = 0 }) {
  try {
    const payload = {
      activeScriptKey,
      scriptType: scriptType || 'sample', // 'sample' | 'custom'
      sampleId: sampleId || null,
      customScriptData: customScriptData || null, // { title, fountainText, characters, scenes, elements }
      activeLineIndex,
      savedAt: Date.now()
    };
    localStorage.setItem(APP_STATE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn('Could not save app state to LocalStorage:', err);
    return false;
  }
}

/**
 * Load global application state
 */
export function loadAppState() {
  try {
    const raw = localStorage.getItem(APP_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Could not load app state from LocalStorage:', err);
    return null;
  }
}

/**
 * Quick update for active playback line in both cast config and app state
 */
export function savePlaybackPosition(scriptKey, lineIndex) {
  try {
    // 1. Update script cast config
    const config = loadScriptCastConfig(scriptKey);
    if (config) {
      config.activeLineIndex = lineIndex;
      config.updatedAt = Date.now();
      saveScriptCastConfig(scriptKey, config);
    }

    // 2. Update app state
    const appState = loadAppState();
    if (appState && appState.activeScriptKey === scriptKey) {
      appState.activeLineIndex = lineIndex;
      appState.savedAt = Date.now();
      localStorage.setItem(APP_STATE_KEY, JSON.stringify(appState));
    }
  } catch (err) {
    console.warn('Could not save playback position:', err);
  }
}

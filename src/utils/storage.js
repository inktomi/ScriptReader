/**
 * Storage Utility for ScriptReader Pro
 * Handles LocalStorage persistence for:
 * - Script character voice assignments (voiceId, pitch, speed, tone)
 * - Narrator voice selection
 * - Playback progress (active line index)
 * - Saved custom and sample script state
 */

import {
  DEFAULT_NARRATOR_VOICE_ID,
  OPENAI_VOICE_CATALOG
} from '../audio/voice-catalog.js';
import { ENGINE_IDS } from '../audio/engine-contract.js';

const STORAGE_PREFIX = 'scriptreader_';
const APP_STATE_KEY = `${STORAGE_PREFIX}app_state_v2`;
const CAST_PREFIX = `${STORAGE_PREFIX}cast_`;
const CAST_BACKUP_SUFFIX = '_v1_backup';

/**
 * Cast schema version.
 *
 * 1 — voices auto-assigned without regard to quality; `am_adam` (upstream grade
 *     F+) was the fallback and `bm_george` (C) the narrator.
 * 2 — grade-ranked assignment, and `auto` records whether a human chose a voice.
 */
export const CAST_VERSION = 2;

/**
 * Generate a consistent, unique key for a script
 */
export function generateLegacyScriptKey(script) {
  if (!script) return 'default';
  if (script.id) {
    return `sample_${script.id}`;
  }
  const cleanTitle = (script.title || 'untitled').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const signature = (script.elements && script.elements[0] ? script.elements[0].text.substring(0, 30) : '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  return `custom_${cleanTitle}_${signature}`;
}

function hashScript(script) {
  const parts = [script.title || ''];
  for (const element of script.elements || []) {
    parts.push(element.type || '', element.character || '', element.text || '', element.parenthetical || '');
  }

  let hash = 0x811c9dc5;
  const input = parts.join('\u001f');
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function generateScriptKey(script) {
  if (!script) return 'default';
  if (script.id) return `sample_${script.id}`;
  const cleanTitle = (script.title || 'untitled').toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `custom_${cleanTitle}_${hashScript(script)}`;
}

/**
 * Save character voice configuration and line position for a specific script
 */
export function saveScriptCastConfig(scriptKey, {
  narratorVoiceId,
  narratorVoiceIds = null,
  castAssignments,
  activeLineIndex = 0,
  scriptTitle = '',
  castVersion = CAST_VERSION
}) {
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
      narratorVoiceIds,
      castAssignments: assignmentsObj,
      activeLineIndex,
      scriptTitle,
      configured: true,
      castVersion,
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
      // Reading a saved config with no narrator recorded must not reinstate the
      // old default, or every load quietly undoes the narrator upgrade.
      narratorVoiceId: parsed.narratorVoiceId || DEFAULT_NARRATOR_VOICE_ID,
      narratorVoiceIds: parsed.narratorVoiceIds || (() => {
        const legacyId = parsed.narratorVoiceId || DEFAULT_NARRATOR_VOICE_ID;
        const engineId = OPENAI_VOICE_CATALOG.some(voice => voice.id === legacyId)
          ? ENGINE_IDS.OPENAI
          : ENGINE_IDS.KOKORO;
        return { [engineId]: legacyId };
      })(),
      castAssignments: castMap,
      activeLineIndex: typeof parsed.activeLineIndex === 'number' ? parsed.activeLineIndex : 0,
      configured: Boolean(parsed.configured),
      // Anything written before versioning existed is v1 by definition.
      castVersion: parsed.castVersion || 1,
      updatedAt: parsed.updatedAt || 0
    };
  } catch (err) {
    console.warn('Could not load script cast config from LocalStorage:', err);
    return null;
  }
}

/**
 * Copy a cast config aside before migrating it, so the change is undoable.
 * No-op when a backup already exists — re-running a migration must never
 * overwrite the original with an already-migrated copy.
 */
export function backupCastConfig(scriptKey) {
  try {
    const backupKey = `${CAST_PREFIX}${scriptKey}${CAST_BACKUP_SUFFIX}`;
    if (localStorage.getItem(backupKey)) return true;
    const raw = localStorage.getItem(`${CAST_PREFIX}${scriptKey}`);
    if (!raw) return false;
    localStorage.setItem(backupKey, raw);
    return true;
  } catch (err) {
    console.warn('Could not back up cast config:', err);
    return false;
  }
}

/**
 * Restore the pre-migration cast, then stamp it as current so the migration
 * does not immediately re-fire and undo the undo.
 */
export function restoreCastBackup(scriptKey) {
  try {
    const backupKey = `${CAST_PREFIX}${scriptKey}${CAST_BACKUP_SUFFIX}`;
    const raw = localStorage.getItem(backupKey);
    if (!raw) return false;

    const parsed = JSON.parse(raw);
    parsed.castVersion = CAST_VERSION;
    localStorage.setItem(`${CAST_PREFIX}${scriptKey}`, JSON.stringify(parsed));
    localStorage.removeItem(backupKey);
    return true;
  } catch (err) {
    console.warn('Could not restore cast backup:', err);
    return false;
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

  } catch (err) {
    console.warn('Could not save playback position:', err);
  }
}

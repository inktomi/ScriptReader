/**
 * Storage for the user's own TTS API key.
 *
 * Kept in its own localStorage entry rather than inside the app-state blob, so
 * that a future state export, debug dump, or "copy my settings" feature cannot
 * sweep a credential along with it by accident. Anything that wants the key has
 * to ask for it by name.
 *
 * On the threat model, plainly: localStorage is readable by any script running
 * on this origin. So are sessionStorage and IndexedDB — there is no browser
 * storage that survives script injection, and with no backend there is nowhere
 * else to put it. The control that actually protects this key is the HTML
 * escaping in `escape-html.js`, which is why that landed first. The second
 * control belongs to the user: a project-scoped key with a spend cap set on the
 * provider's side, which is the only mitigation that still works if this origin
 * is ever compromised.
 */

import { readBoundedResponseJson } from './bounded-response.js';

const OPENAI_KEY = 'scriptreader_openai_key_v1';
const RUNPOD_KEY = 'scriptreader_runpod_key_v1';
const RUNPOD_ENDPOINT_KEY = 'scriptreader_runpod_endpoint_v1';
const DEFAULT_RUNPOD_ENDPOINT = 'lp3hrmg85v80jm';
const ENGINE_SETTINGS_KEY = 'scriptreader_engine_settings_v1';

/**
 * Bump when the consent wording changes materially, so consent is re-sought
 * rather than inherited from a disclosure the user never actually read.
 */
export const CLOUD_DISCLOSURE_VERSION = 2;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;

export function loadOpenAIKey() {
  try {
    return localStorage.getItem(OPENAI_KEY) || '';
  } catch {
    return '';
  }
}

export function saveOpenAIKey(key) {
  try {
    const trimmed = (key || '').trim();
    if (!trimmed) {
      localStorage.removeItem(OPENAI_KEY);
      return true;
    }
    localStorage.setItem(OPENAI_KEY, trimmed);
    return true;
  } catch (err) {
    console.warn('Could not store API key:', err);
    return false;
  }
}

export function clearOpenAIKey() {
  try {
    localStorage.removeItem(OPENAI_KEY);
    return true;
  } catch {
    return false;
  }
}

export function hasOpenAIKey() {
  return loadOpenAIKey().length > 0;
}

/** `sk-proj-abc…w9Fq` — enough to recognise a key, not enough to use one. */
export function maskKey(key) {
  const value = (key || '').trim();
  if (!value) return '';
  if (value.length <= 12) return `${value.slice(0, 3)}…`;
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

export function loadEngineSettings() {
  try {
    const raw = localStorage.getItem(ENGINE_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveEngineSettings(patch) {
  try {
    const next = { ...loadEngineSettings(), ...patch };
    localStorage.setItem(ENGINE_SETTINGS_KEY, JSON.stringify(next));
    return next;
  } catch (err) {
    console.warn('Could not store engine settings:', err);
    return loadEngineSettings();
  }
}

export function hasCloudConsent() {
  const settings = loadEngineSettings();
  return settings.cloudConsentVersion === CLOUD_DISCLOSURE_VERSION;
}

export function grantCloudConsent() {
  return saveEngineSettings({
    cloudConsentVersion: CLOUD_DISCLOSURE_VERSION,
    cloudConsentAt: Date.now(),
  });
}

export function revokeCloudConsent() {
  return saveEngineSettings({ cloudConsentVersion: null, cloudConsentAt: null });
}

/**
 * Cheapest possible liveness check.
 *
 * A model lookup is free, carries the same Authorization header the synthesis
 * endpoint will, and separates the three outcomes that need different messages:
 * the key is wrong (401), the key is real but cannot reach this model (403/404),
 * or it works. Validating by synthesising a word would bill the user every time
 * they opened the settings modal.
 *
 * CORS on this route is verified: it answers preflight with
 * `access-control-allow-origin: *` and allows the `authorization` header.
 */
export async function validateOpenAIKey(key, { signal, model = 'gpt-4o-mini-tts' } = {}) {
  const trimmed = (key || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  try {
    const res = await fetch(`https://api.openai.com/v1/models/${model}`, {
      headers: { authorization: `Bearer ${trimmed}` },
      signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, reason: 'invalid_key' };
    if (res.status === 403 || res.status === 404) return { ok: false, reason: 'no_model_access' };
    if (res.status === 429) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: `http_${res.status}` };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { ok: false, reason: 'network' };
  }
}

export function describeValidationReason(reason) {
  switch (reason) {
    case 'empty':
      return 'Enter a key to continue.';
    case 'invalid_key':
      return 'OpenAI rejected this key.';
    case 'no_model_access':
      return 'This key cannot reach gpt-4o-mini-tts. Check the project it belongs to.';
    case 'rate_limited':
      return 'OpenAI is rate limiting this key right now. Try again shortly.';
    case 'network':
      return 'Could not reach OpenAI. Check your connection.';
    default:
      return 'Could not verify this key.';
  }
}

export { DEFAULT_RUNPOD_ENDPOINT };

export function loadRunPodKey() {
  try {
    return localStorage.getItem(RUNPOD_KEY) || '';
  } catch {
    return '';
  }
}

export function saveRunPodKey(key) {
  try {
    const trimmed = (key || '').trim();
    if (!trimmed) {
      localStorage.removeItem(RUNPOD_KEY);
      return true;
    }
    localStorage.setItem(RUNPOD_KEY, trimmed);
    return true;
  } catch (err) {
    console.warn('Could not store RunPod API key:', err);
    return false;
  }
}

export function clearRunPodKey() {
  try {
    localStorage.removeItem(RUNPOD_KEY);
    return true;
  } catch {
    return false;
  }
}

export function hasRunPodKey() {
  return loadRunPodKey().length > 0;
}

export function loadRunPodEndpointId() {
  try {
    return localStorage.getItem(RUNPOD_ENDPOINT_KEY) || DEFAULT_RUNPOD_ENDPOINT;
  } catch {
    return DEFAULT_RUNPOD_ENDPOINT;
  }
}

export function saveRunPodEndpointId(endpointId) {
  try {
    const trimmed = (endpointId || '').trim();
    if (!trimmed) {
      localStorage.removeItem(RUNPOD_ENDPOINT_KEY);
      return true;
    }
    localStorage.setItem(RUNPOD_ENDPOINT_KEY, trimmed);
    return true;
  } catch (err) {
    console.warn('Could not store RunPod endpoint ID:', err);
    return false;
  }
}

export async function validateRunPodConnection({ key, endpointId, signal } = {}) {
  const apiKey = (key || loadRunPodKey()).trim();
  const ep = (endpointId || loadRunPodEndpointId()).trim() || DEFAULT_RUNPOD_ENDPOINT;
  if (!apiKey) return { ok: false, reason: 'empty_key' };

  try {
    const res = await fetch(`https://api.runpod.ai/v2/${ep}/health`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (res.ok) {
      const data = await readBoundedResponseJson(res, {
        maxBytes: MAX_HEALTH_RESPONSE_BYTES,
        signal,
        tooLargeError: () => new Error('RunPod returned an oversized health response.'),
      });
      return { ok: true, data };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid_key' };
    if (res.status === 404) return { ok: false, reason: 'invalid_endpoint' };
    return { ok: false, reason: `http_${res.status}` };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { ok: false, reason: 'network' };
  }
}

export function describeRunPodValidationReason(reason) {
  switch (reason) {
    case 'empty_key':
      return 'Enter your RunPod API key to continue.';
    case 'invalid_key':
      return 'RunPod rejected this API key.';
    case 'invalid_endpoint':
      return 'Could not find this Serverless Endpoint ID on RunPod.';
    case 'network':
      return 'Could not reach RunPod. Check your internet connection.';
    default:
      return 'Could not verify RunPod connection.';
  }
}

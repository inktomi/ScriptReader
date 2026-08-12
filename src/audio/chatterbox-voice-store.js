import { getAudioContext } from './audio-context.js';

const DB_NAME = 'scriptreader-studio-voices';
const DB_VERSION = 1;
const STORE_NAME = 'samples';
const META_KEY = 'scriptreader_chatterbox_voice_metadata';
const TARGET_SAMPLE_RATE = 24000;
const MIN_REFERENCE_SECONDS = 3;
const MAX_REFERENCE_SECONDS = 12;

function storage() {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function readMetadata() {
  try {
    const parsed = JSON.parse(storage()?.getItem(META_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => item && item.id && item.name) : [];
  } catch (_) {
    return [];
  }
}

function writeMetadata(items) {
  try {
    storage()?.setItem(META_KEY, JSON.stringify(items));
  } catch (error) {
    throw new Error('The reference voice could not be saved in this browser.');
  }
}

function openDatabase() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('This browser cannot store Studio voice references.'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the Studio voice library.'));
  });
}

async function putSample(record) {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not store the voice sample.'));
      transaction.onabort = () => reject(transaction.error || new Error('Voice storage was interrupted.'));
    });
  } finally {
    db.close();
  }
}

async function deleteSample(id) {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not remove the voice sample.'));
      transaction.onabort = () => reject(transaction.error || new Error('Voice storage cleanup was interrupted.'));
    });
  } finally {
    db.close();
  }
}

function abortError() {
  const error = new Error('Voice import was cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export async function hasChatterboxVoiceSample(id) {
  if (!id) return false;
  try {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve(!!request.result?.audio);
        request.onerror = () => reject(request.error || new Error('Could not check the voice sample.'));
      });
    } finally {
      db.close();
    }
  } catch (_) {
    return false;
  }
}

export async function getChatterboxVoiceSample(id) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (!record || !record.audio) {
          reject(new Error('This Studio voice is missing its reference recording. Add it again in casting.'));
          return;
        }
        resolve(record.audio instanceof Float32Array
          ? record.audio
          : new Float32Array(record.audio));
      };
      request.onerror = () => reject(request.error || new Error('Could not read the reference voice.'));
    });
  } finally {
    db.close();
  }
}

export function listChatterboxVoices() {
  return readMetadata().map((item, index) => ({
    id: item.id,
    chatterboxId: item.id,
    name: metadataText(item.name, 'Studio voice', 80),
    sex: ['Female', 'Male', 'Neutral'].includes(item.sex) ? item.sex : 'Neutral',
    ageGroup: metadataText(item.ageGroup, 'Reference performance', 40),
    accent: metadataText(item.accent, 'Cloned', 60),
    tone: metadataText(item.tone, 'Natural character voice from a private reference recording', 120),
    description: metadataText(item.description, '', 240)
      ? `${metadataText(item.description, '', 240)} · ${Number(item.duration || 0).toFixed(1)} second local reference`
      : `${Number(item.duration || 0).toFixed(1)} second reference · stored only on this device`,
    avatarBg: '#343027',
    suggestedRoles: [],
    defaultPitch: 1,
    defaultSpeed: 1,
    sampleLine: 'This is how the character will sound in your listening room.',
    source: metadataText(item.source, 'Private upload', 80),
    sourceVoiceId: metadataText(item.sourceVoiceId, '', 100),
    createdAt: item.createdAt || index
  }));
}

function mixToMono(buffer) {
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

function resampleLinear(source, sourceRate, targetRate) {
  if (sourceRate === targetRate) return source.slice();
  const targetLength = Math.max(1, Math.round(source.length * targetRate / sourceRate));
  const output = new Float32Array(targetLength);
  const scale = sourceRate / targetRate;
  for (let i = 0; i < targetLength; i++) {
    const sourcePosition = i * scale;
    const left = Math.floor(sourcePosition);
    const right = Math.min(source.length - 1, left + 1);
    const mix = sourcePosition - left;
    output[i] = source[left] * (1 - mix) + source[right] * mix;
  }
  return output;
}

function voiceNameFromFile(file) {
  const base = (file.name || 'Studio voice').replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base || 'Studio voice';
}

function metadataText(value, fallback = '', maxLength = 160) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, maxLength);
}

export async function saveChatterboxVoice(file, name = '', profile = {}, { signal } = {}) {
  throwIfAborted(signal);
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('Choose an audio recording to create a Studio voice.');
  }

  const context = getAudioContext();
  if (!context || typeof context.decodeAudioData !== 'function') {
    throw new Error('This browser cannot decode reference audio.');
  }

  let decoded;
  try {
    decoded = await context.decodeAudioData(await file.arrayBuffer());
  } catch (_) {
    throw new Error('That recording could not be decoded. Try WAV, MP3, M4A, or OGG.');
  }

  if (decoded.duration < MIN_REFERENCE_SECONDS) {
    throw new Error(`Use at least ${MIN_REFERENCE_SECONDS} seconds of clear speech; 5–10 seconds works best.`);
  }

  throwIfAborted(signal);

  const mono = mixToMono(decoded);
  const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  const maxSamples = TARGET_SAMPLE_RATE * MAX_REFERENCE_SECONDS;
  const audio = resampled.length > maxSamples ? resampled.slice(0, maxSamples) : resampled;
  const sourceVoiceId = metadataText(profile.sourceVoiceId, '', 100);
  const currentMetadata = readMetadata();
  const replacedIds = sourceVoiceId
    ? currentMetadata.filter(item => item.sourceVoiceId === sourceVoiceId).map(item => item.id)
    : [];
  // Reuse a catalog voice's local identity. Cast assignments remain valid even
  // if the catalog closes after IndexedDB commits but before the UI reconciles.
  const id = replacedIds[0]
    || `studio-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const isReplacement = replacedIds.includes(id);
  const duration = audio.length / TARGET_SAMPLE_RATE;
  const record = { id, audio, sampleRate: TARGET_SAMPLE_RATE, duration, createdAt: Date.now() };

  await putSample(record);
  try {
    throwIfAborted(signal);
  } catch (error) {
    if (!isReplacement) {
      await deleteSample(id).catch(() => {});
      throw error;
    }
    // Replacements have crossed the storage commit point. Finish their
    // metadata update so the stable ID never describes a missing sample.
  }
  // A catalog voice is a replaceable source, not an endlessly duplicated
  // identity. This also repairs metadata whose IndexedDB sample was evicted.
  const metadata = currentMetadata.filter(item => !sourceVoiceId || item.sourceVoiceId !== sourceVoiceId);
  metadata.push({
    id,
    name: (name || voiceNameFromFile(file)).slice(0, 80),
    duration,
    sex: metadataText(profile.sex, 'Neutral', 24),
    ageGroup: metadataText(profile.ageGroup, 'Reference performance', 40),
    accent: metadataText(profile.accent, 'Cloned', 60),
    tone: metadataText(profile.tone, 'Natural character voice from a private reference recording', 120),
    description: metadataText(profile.description, '', 240),
    source: metadataText(profile.source, 'Private upload', 80),
    sourceVoiceId,
    createdAt: record.createdAt
  });
  try {
    writeMetadata(metadata);
  } catch (error) {
    // IndexedDB and localStorage cannot share a transaction. Roll back the
    // sample when its discoverability metadata fails so retries do not leak
    // hidden Float32Array records.
    if (!isReplacement) await deleteSample(id).catch(() => {});
    throw error;
  }
  await Promise.all(replacedIds.filter(replacedId => replacedId !== id).map(replacedId => (
    deleteSample(replacedId).catch(() => {})
  )));
  return metadata.at(-1);
}

export const CHATTERBOX_REFERENCE_LIMITS = Object.freeze({
  minSeconds: MIN_REFERENCE_SECONDS,
  maxSeconds: MAX_REFERENCE_SECONDS,
  sampleRate: TARGET_SAMPLE_RATE
});

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
    name: item.name,
    sex: item.sex || 'Neutral',
    ageGroup: 'Reference performance',
    accent: item.accent || 'Cloned',
    tone: 'Natural character voice from a private reference recording',
    description: `${Number(item.duration || 0).toFixed(1)} second reference · stored only on this device`,
    avatarBg: '#343027',
    suggestedRoles: [],
    defaultPitch: 1,
    defaultSpeed: 1,
    sampleLine: 'This is how the character will sound in your listening room.',
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

export async function saveChatterboxVoice(file, name = '') {
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

  const mono = mixToMono(decoded);
  const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  const maxSamples = TARGET_SAMPLE_RATE * MAX_REFERENCE_SECONDS;
  const audio = resampled.length > maxSamples ? resampled.slice(0, maxSamples) : resampled;
  const id = `studio-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const duration = audio.length / TARGET_SAMPLE_RATE;
  const record = { id, audio, sampleRate: TARGET_SAMPLE_RATE, duration, createdAt: Date.now() };

  await putSample(record);
  const metadata = readMetadata();
  metadata.push({
    id,
    name: (name || voiceNameFromFile(file)).slice(0, 80),
    duration,
    createdAt: record.createdAt
  });
  writeMetadata(metadata);
  return metadata.at(-1);
}

export const CHATTERBOX_REFERENCE_LIMITS = Object.freeze({
  minSeconds: MIN_REFERENCE_SECONDS,
  maxSeconds: MAX_REFERENCE_SECONDS,
  sampleRate: TARGET_SAMPLE_RATE
});

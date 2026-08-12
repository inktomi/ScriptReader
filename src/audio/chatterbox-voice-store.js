import { getAudioContext } from './audio-context.js';
import { createMutationQueue, runStagedMutation } from '../utils/staged-mutation.js';
import { throwIfAborted } from '../utils/latest-operation.js';

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

function parseMetadata(raw) {
  const parsed = JSON.parse(raw || '[]');
  if (!Array.isArray(parsed)) throw new Error('Studio voice metadata is malformed.');
  return parsed.filter(item => item && item.id && item.name);
}

function readMetadataStrict() {
  const metadataStorage = storage();
  if (!metadataStorage) throw new Error('Local storage is unavailable.');
  return parseMetadata(metadataStorage.getItem(META_KEY));
}

function readMetadata() {
  try {
    return readMetadataStrict();
  } catch (_) {
    return [];
  }
}

function writeMetadata(items) {
  try {
    const metadataStorage = storage();
    if (!metadataStorage) throw new Error('Local storage is unavailable.');
    metadataStorage.setItem(META_KEY, JSON.stringify(items));
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

async function deleteSamples(ids) {
  if (ids.length === 0) return;
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      ids.forEach(id => store.delete(id));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not remove voice samples.'));
      transaction.onabort = () => reject(transaction.error || new Error('Voice storage cleanup was interrupted.'));
    });
  } finally {
    db.close();
  }
}

function hasUsableAudio(record) {
  if (!record?.audio) return false;
  const length = Number(record.audio.length ?? record.audio.byteLength ?? 0);
  return Number.isFinite(length) && length > 0;
}

async function inspectSampleRecords() {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const summaries = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(summaries);
          return;
        }
        summaries.push({ id: String(cursor.key), usable: hasUsableAudio(cursor.value) });
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('Could not inspect stored voice samples.'));
    });
  } finally {
    db.close();
  }
}

const defaultPersistence = {
  readMetadata: readMetadataStrict,
  writeMetadata,
  putSample,
  deleteSample,
  deleteSamples,
  inspectSampleRecords
};
const voiceMutationQueue = createMutationQueue({
  lockName: 'scriptreader-chatterbox-voice-mutation'
});

/**
 * Removes metadata whose sample was evicted and samples that no metadata can
 * discover. Metadata is repaired first; orphan deletion never runs if that
 * write fails, so a cleanup attempt cannot create a newly broken reference.
 */
export async function reconcileChatterboxVoiceStorage({ persistence = defaultPersistence } = {}) {
  return await voiceMutationQueue.run(async () => {
    const metadata = persistence.readMetadata();
    const sampleRecords = await persistence.inspectSampleRecords();
    const sampleIds = sampleRecords.map(record => String(record.id));
    const samples = new Set(sampleRecords.filter(record => record.usable).map(record => String(record.id)));
    const validMetadata = metadata.filter(item => samples.has(item.id));
    const removedMetadata = metadata.length - validMetadata.length;
    if (removedMetadata > 0) await persistence.writeMetadata(validMetadata);

    const referenced = new Set(validMetadata.map(item => item.id));
    const orphanIds = sampleIds.filter(id => !referenced.has(id));
    let failedOrphanIds = [];
    if (typeof persistence.deleteSamples === 'function') {
      try {
        await persistence.deleteSamples(orphanIds);
      } catch (_) {
        // The default bulk cleanup is one IndexedDB transaction, so a failure
        // leaves the whole set for a later reconciliation attempt.
        failedOrphanIds = orphanIds;
      }
    } else {
      const cleanup = await Promise.allSettled(orphanIds.map(id => persistence.deleteSample(id)));
      failedOrphanIds = orphanIds.filter((_, index) => cleanup[index].status === 'rejected');
    }
    return { removedMetadata, removedOrphans: orphanIds.length - failedOrphanIds.length, failedOrphanIds };
  });
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

export async function saveChatterboxVoice(file, name = '', profile = {}, {
  signal,
  persistence = defaultPersistence
} = {}) {
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
  const duration = audio.length / TARGET_SAMPLE_RATE;
  return await voiceMutationQueue.run(async () => {
    throwIfAborted(signal);
    const sourceVoiceId = metadataText(profile.sourceVoiceId, '', 100);
    const currentMetadata = persistence.readMetadata();
    const replacedIds = sourceVoiceId
      ? currentMetadata.filter(item => item.sourceVoiceId === sourceVoiceId).map(item => item.id)
      : [];
    // Reuse a catalog voice's local identity. Cast assignments remain valid
    // when refreshing the same provider voice.
    const id = replacedIds[0]
      || `studio-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const isReplacement = replacedIds.includes(id);
    const record = { id, audio, sampleRate: TARGET_SAMPLE_RATE, duration, createdAt: Date.now() };
    // A catalog voice is a replaceable source, not an endlessly duplicated
    // identity. This also repairs metadata whose IndexedDB sample was evicted.
    const metadata = currentMetadata.filter(item => !sourceVoiceId || item.sourceVoiceId !== sourceVoiceId);
    const savedMetadata = {
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
    };
    metadata.push(savedMetadata);

    return await runStagedMutation({
      signal,
      // Decoding/resampling produced the in-memory staged record. IndexedDB's
      // stable-ID put is the one atomic durable boundary; it never exposes a
      // partial replacement and does not require a quota-consuming duplicate.
      stage: async () => record,
      commitDurable: async stagedRecord => {
        await persistence.putSample(stagedRecord);
        return stagedRecord;
      },
      persistMetadata: async () => {
        await persistence.writeMetadata(metadata);
        return savedMetadata;
      },
      compensateDurable: async () => {
        if (!isReplacement) await persistence.deleteSample(id);
      },
      reconcile: async () => {
        await Promise.all(replacedIds.filter(replacedId => replacedId !== id).map(replacedId => (
          persistence.deleteSample(replacedId).catch(() => {})
        )));
      }
    });
  });
}

export const CHATTERBOX_REFERENCE_LIMITS = Object.freeze({
  minSeconds: MIN_REFERENCE_SECONDS,
  maxSeconds: MAX_REFERENCE_SECONDS,
  sampleRate: TARGET_SAMPLE_RATE
});

const DB_NAME = 'scriptreader-studio-renders';
const DB_VERSION = 1;
const RENDER_STORE = 'renders';
const META_STORE = 'metadata';
const TOTAL_KEY = 'total-bytes';

// PCM16 mono at 24 kHz is about 165 MB per hour. This ceiling holds more than
// four hours of rendered dialogue while preventing an accidentally enormous
// import from consuming browser storage without limit.
export const MAX_RENDER_CACHE_BYTES = 768 * 1024 * 1024;
export const MAX_RENDER_CACHE_SECONDS = MAX_RENDER_CACHE_BYTES / (24000 * Int16Array.BYTES_PER_ELEMENT);

function openDatabase() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('This browser cannot persist rendered Studio audio.'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RENDER_STORE)) {
        const renders = db.createObjectStore(RENDER_STORE, { keyPath: 'key' });
        renders.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the Studio render cache.'));
  });
}

export function encodePcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return pcm;
}

export function decodePcm16(pcm) {
  const source = pcm instanceof Int16Array ? pcm : new Int16Array(pcm);
  const samples = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) {
    samples[i] = source[i] < 0 ? source[i] / 0x8000 : source[i] / 0x7fff;
  }
  return samples;
}

async function readRecord(key) {
  if (!key) return null;
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(RENDER_STORE, 'readonly').objectStore(RENDER_STORE).get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (!record?.audio || !Number.isFinite(record.sampleRate)) return resolve(null);
        resolve({
          audio: record.audio instanceof Int16Array ? record.audio : new Int16Array(record.audio),
          sampleRate: record.sampleRate,
          duration: record.duration,
        });
      };
      request.onerror = () => reject(request.error || new Error('Could not read rendered Studio audio.'));
    });
  } finally {
    db.close();
  }
}

async function writeRecord(key, samples, sampleRate) {
  const pcm = encodePcm16(samples);
  const record = {
    key,
    audio: pcm,
    sampleRate,
    duration: pcm.length / sampleRate,
    bytes: pcm.byteLength,
    createdAt: Date.now(),
  };
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([RENDER_STORE, META_STORE], 'readwrite');
      const renders = transaction.objectStore(RENDER_STORE);
      const metadata = transaction.objectStore(META_STORE);
      const existingRequest = renders.get(key);
      const totalRequest = metadata.get(TOTAL_KEY);
      let existingReady = false;
      let totalReady = false;
      let existing = null;
      let total = 0;

      const commit = () => {
        if (!existingReady || !totalReady) return;
        total = Math.max(0, total - (Number(existing?.bytes) || 0) + record.bytes);
        renders.put(record);
        metadata.put({ id: TOTAL_KEY, bytes: total });
        if (total <= MAX_RENDER_CACHE_BYTES) return;

        const cursorRequest = renders.index('createdAt').openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || total <= MAX_RENDER_CACHE_BYTES) return;
          if (cursor.primaryKey === key && record.bytes <= MAX_RENDER_CACHE_BYTES) {
            cursor.continue();
            return;
          }
          total = Math.max(0, total - (Number(cursor.value?.bytes) || 0));
          cursor.delete();
          metadata.put({ id: TOTAL_KEY, bytes: total });
          cursor.continue();
        };
      };

      existingRequest.onsuccess = () => {
        existing = existingRequest.result;
        existingReady = true;
        commit();
      };
      totalRequest.onsuccess = () => {
        total = Number(totalRequest.result?.bytes) || 0;
        totalReady = true;
        commit();
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not persist rendered Studio audio.'));
      transaction.onabort = () => reject(transaction.error || new Error('Studio render storage was interrupted.'));
    });
  } finally {
    db.close();
  }
}

async function clearRecords() {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([RENDER_STORE, META_STORE], 'readwrite');
      transaction.objectStore(RENDER_STORE).clear();
      transaction.objectStore(META_STORE).put({ id: TOTAL_KEY, bytes: 0 });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not clear rendered Studio audio.'));
      transaction.onabort = () => reject(transaction.error || new Error('Studio render cleanup was interrupted.'));
    });
  } finally {
    db.close();
  }
}

// Reads degrade to a cache miss when IndexedDB is unavailable. Writes stay
// strict: claiming a full render is ready when it was only held in the bounded
// memory cache would bring the mid-script pauses back on longer reads.
export const chatterboxRenderStore = {
  async get(key) {
    try {
      return await readRecord(key);
    } catch (_) {
      return null;
    }
  },
  async put(key, samples, sampleRate) {
    await writeRecord(key, samples, sampleRate);
  },
  async clear() {
    try {
      await clearRecords();
      return true;
    } catch (_) {
      return false;
    }
  },
};

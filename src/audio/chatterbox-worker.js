import { AutoProcessor, ChatterboxModel, env, Tensor } from 'transformers-v4';
import {
  DTYPE_CONFIGS,
  expectedFilesFor,
  isCompleteSize,
  CHATTERBOX_MODEL_ID as MODEL_ID,
  OPFS_NAMESPACE,
  pickChatterboxDevice,
} from './chatterbox-model-files.js';
import { createOpfsModelCache } from './opfs-model-cache.js';

env.allowLocalModels = false;

// Every host that can end up serving bytes for this model. `huggingface.co`
// only issues the redirect; the object itself comes from an LFS or Xet transfer
// host, and that is the request that actually needs the referrer stripped —
// huggingface.co and its CDNs drop `Access-Control-Allow-Origin` when a request
// carries a Referer from this origin (see `public/_headers`). Missing a
// transfer host here means the weight fetch fails CORS, not that it is merely
// slower.
const HF_HOSTS = [
  'huggingface.co',
  'hf.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'xethub.hf.co',
  'xet.huggingface.co',
];

const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  let isHuggingFace = false;
  try {
    isHuggingFace = !!url && HF_HOSTS.some((host) => new URL(url, self.location.href).hostname.endsWith(host));
  } catch (_) {
    isHuggingFace = false;
  }
  return isHuggingFace ? nativeFetch(input, { ...init, referrerPolicy: 'no-referrer' }) : nativeFetch(input, init);
};

// How many weight files stream at once. Two rather than one so a high-latency
// link is not left idle between files, and rather than four because each one is
// hundreds of megabytes and they would only compete for the same bandwidth
// while making the progress story harder to read.
const PREFETCH_CONCURRENCY = 2;

// Progress is coalesced into one message per interval. The download emits a
// callback per network chunk — tens of thousands of them across 1.4 GB — and
// `init_complete` shares the same message queue, so an unthrottled relay does
// not merely make the bar expensive to draw, it puts completion behind a
// backlog the main thread has to drain first.
const POST_INTERVAL_MS = 150;

const DTYPE_FALLBACK_ORDER = { webgpu: ['webgpu', 'wasm'], wasm: ['wasm'] };

let model = null;
let processor = null;
let device = null;
const speakers = new Map();
const queue = [];
let sequence = 0;
let processing = false;

// file -> { loaded, total, status }. Held per file rather than as a single
// newest-sample, because files stream in parallel: a scalar would let whichever
// file reported last stand in for all of them.
const progressState = new Map();
let progressStage = 'download';
let postTimer = null;

function flushProgress() {
  if (postTimer !== null) {
    clearTimeout(postTimer);
    postTimer = null;
  }
  if (progressState.size === 0) return;

  self.postMessage({
    type: 'progress',
    payload: {
      stage: progressStage,
      files: [...progressState.entries()].map(([file, entry]) => ({ file, ...entry })),
    },
  });
}

function scheduleProgress() {
  if (postTimer !== null) return;
  postTimer = setTimeout(() => {
    postTimer = null;
    flushProgress();
  }, POST_INTERVAL_MS);
}

function noteProgress(file, entry, immediate = false) {
  progressState.set(file, { ...progressState.get(file), ...entry });
  if (immediate) flushProgress();
  else scheduleProgress();
}

function setStage(stage) {
  if (progressStage === stage) return;
  progressStage = stage;
  // A stage change is a phase transition the engine keys its whole readout off,
  // so it never waits behind the timer.
  flushProgress();
}

function postError(id, error) {
  // Flush first: otherwise a timer that has already been scheduled fires after
  // the failure and rewinds the UI from its error state back to a loading one.
  flushProgress();
  self.postMessage({ type: 'error', id, error: error?.message || 'Studio voice generation failed.' });
}

const ORT_ASSET_TYPES = { mjs: 'text/javascript', wasm: 'application/wasm' };

/**
 * Move the ONNX Runtime files onto same-origin blob URLs.
 *
 * transformers.js points `wasmPaths` at a jsdelivr prefix, and `vite.config.js`
 * rebases ORT's own `new URL(…, import.meta.url)` fallback there too, to keep a
 * 27 MB binary out of the deployed bundle. Fetching across origins is fine — but
 * ORT does not only fetch these files. `public/_headers` deliberately makes this
 * app cross-origin isolated so WASM can use threads, and ORT's thread pool starts
 * with `new Worker(<the .mjs URL>)`. A Worker cannot be constructed from another
 * origin, so that throws SecurityError, every execution provider fails to
 * initialise, and the whole thing surfaces as the singularly unhelpful "no
 * available backend found".
 *
 * Blob URLs are same-origin, so handing ORT one fixes that without self-hosting
 * anything. Sourcing them through the cache is the other half of the point: until
 * now the runtime was re-fetched from a CDN on every visit, which meant Studio
 * Local was never actually usable offline no matter how local its weights were.
 */
async function localiseOrtRuntime(cache) {
  const wasm = env.backends?.onnx?.wasm;
  const paths = wasm?.wasmPaths;
  if (!wasm || !paths || typeof paths !== 'object') return;

  const localised = { ...paths };
  for (const [key, type] of Object.entries(ORT_ASSET_TYPES)) {
    const source = paths[key];
    if (typeof source !== 'string' || source.startsWith('blob:')) continue;

    let response = null;
    if (cache) {
      response = await cache.match(source);
      if (!response) {
        const file = `runtime/${source.split('/').pop()}`;
        noteProgress(file, { loaded: 0, total: 0, status: 'initiate' }, true);
        await cache.download(source, {
          onProgress: ({ loaded, total }) => noteProgress(file, { loaded, total, status: 'progress' }),
        });
        noteProgress(file, { status: 'done' }, true);
        response = await cache.match(source);
      }
    } else {
      response = await fetch(source);
      if (!response.ok) continue;
    }
    if (!response) continue;

    localised[key] = URL.createObjectURL(new Blob([await response.blob()], { type }));
  }

  wasm.wasmPaths = localised;
}

/**
 * Fetch every file the model needs straight to disk before handing over to
 * transformers.js.
 *
 * This is deliberately not the library's job. Left to itself it reads each file
 * into memory through `readResponse`, which — with no `Content-Length` from
 * Hugging Face — reallocates and copies its entire accumulated buffer on every
 * chunk. For the 591 MB encoder that is terabytes of copying and a transient
 * heap of twice the file; across four concurrent sessions it is enough to get
 * the worker killed outright, which is a death that fires no error event.
 *
 * Streaming to OPFS here keeps memory at one chunk, and the library then reads
 * each file back from a cache that reports its size exactly, so the growth loop
 * never runs at all.
 */
async function prefetchWeights(cache, targetDevice) {
  const files = expectedFilesFor(targetDevice);
  const outstanding = [];

  for (const file of files) {
    const onDisk = await cache.sizeOf(file.url);
    if (isCompleteSize(onDisk, file.bytes)) {
      // Seed it as complete so a resumed install starts partway along the bar
      // instead of at zero.
      noteProgress(file.path, { loaded: onDisk, total: onDisk, status: 'done' });
    } else {
      noteProgress(file.path, { loaded: 0, total: file.bytes, status: 'initiate' });
      outstanding.push(file);
    }
  }
  flushProgress();

  if (outstanding.length === 0) return;

  const pending = [...outstanding];
  const run = async () => {
    for (;;) {
      const file = pending.shift();
      if (!file) return;
      await cache.download(file.url, {
        expectedBytes: file.bytes,
        onProgress: ({ loaded, total }) => noteProgress(file.path, { loaded, total, status: 'progress' }),
      });
      noteProgress(file.path, { status: 'done' }, true);
    }
  };

  await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, pending.length) }, run));
}

async function loadModel(targetDevice) {
  const dtype = DTYPE_CONFIGS[targetDevice];
  const progress_callback = (progress) => {
    if (!progress || typeof progress.file !== 'string') return;
    noteProgress(
      progress.file,
      {
        loaded: Number(progress.loaded) || 0,
        total: Number(progress.total) || 0,
        status: progress.status || 'progress',
      },
      progress.status === 'initiate' || progress.status === 'done',
    );
  };

  processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
  model = await ChatterboxModel.from_pretrained(MODEL_ID, { device: targetDevice, dtype, progress_callback });
  return dtype;
}

async function initialize(id, payload = {}) {
  try {
    // Cache Storage cannot hold these files at all, so a browser without OPFS
    // can run the engine but cannot keep it: say so via `retained` rather than
    // letting the UI claim an install that will not survive a reload.
    const cache = await createOpfsModelCache(OPFS_NAMESPACE);
    if (cache) {
      env.useCustomCache = true;
      env.customCache = cache;
      env.useBrowserCache = false;
    } else {
      env.useBrowserCache = true;
    }

    const preferred = await pickChatterboxDevice(payload.device);
    const attempts = DTYPE_FALLBACK_ORDER[preferred] || ['wasm'];
    let lastError = null;

    setStage('download');
    await localiseOrtRuntime(cache);

    for (const attempt of attempts) {
      // Prefetch per attempt, not once up front: falling back to wasm swaps
      // `language_model_q4f16` for `q4`, a file the webgpu pass never fetched.
      // Everything else is already on disk, so this only pulls the difference.
      setStage('download');
      if (cache) await prefetchWeights(cache, attempt);

      setStage('building');
      try {
        const dtype = await loadModel(attempt);
        device = attempt;
        flushProgress();
        self.postMessage({
          type: 'init_complete',
          id,
          payload: { device, dtype, retained: !!cache },
        });
        return;
      } catch (error) {
        // Session creation is what fails here — the bytes are already local by
        // this point — so retrying on another device is worth the differing
        // weight file. A prefetch failure is a network problem and escapes to
        // the outer catch instead, because no other device would fix it.
        lastError = error;
        console.warn(`Studio Local init failed on ${attempt}:`, error);
        model = null;
        processor = null;
      }
    }

    throw lastError || new Error('Studio Local could not start on this device.');
  } catch (error) {
    postError(id, error);
  }
}

async function encodeSpeaker(task) {
  if (speakers.has(task.payload.voiceId)) return;
  const audio = new Float32Array(task.payload.audio);
  const tensor = new Tensor('float32', audio, [1, audio.length]);
  const embeddings = await model.encode_speech(tensor);
  speakers.set(task.payload.voiceId, embeddings);
}

async function generate(task) {
  if (!model || !processor) throw new Error('Studio Local is not installed yet.');
  await encodeSpeaker(task);
  const text = task.payload.text || '';
  const inputs = await processor._call(text);

  const waveform = await model.generate({
    ...inputs,
    ...speakers.get(task.payload.voiceId),
    exaggeration: task.payload.exaggeration ?? 0.5,
    max_new_tokens: task.payload.maxNewTokens || 512,
  });
  const samples = waveform.data instanceof Float32Array ? waveform.data : new Float32Array(waveform.data);
  const output = samples.slice();
  self.postMessage(
    {
      type: 'generate_complete',
      id: task.id,
      payload: { audio: output, sampling_rate: 24000 },
    },
    [output.buffer],
  );
}

function takeNext() {
  if (queue.length === 0) return null;
  let best = 0;
  for (let i = 1; i < queue.length; i++) {
    if (
      queue[i].priority < queue[best].priority ||
      (queue[i].priority === queue[best].priority && queue[i].sequence < queue[best].sequence)
    ) {
      best = i;
    }
  }
  return queue.splice(best, 1)[0];
}

async function pump() {
  if (processing) return;
  processing = true;
  try {
    let task = takeNext();
    while (task) {
      try {
        await generate(task);
      } catch (error) {
        postError(task.id, error);
      }
      task = takeNext();
    }
  } finally {
    processing = false;
  }
  if (queue.length) pump();
}

self.onmessage = (event) => {
  const { type, id, payload = {} } = event.data || {};
  if (type === 'init') {
    initialize(id, payload);
    return;
  }
  if (type === 'generate') {
    queue.push({ id, payload, priority: payload.priority ?? 1000, sequence: sequence++ });
    pump();
    return;
  }
  if (type === 'reprioritize') {
    for (const task of queue) {
      const priority = payload.priorities?.[task.payload.key];
      if (typeof priority === 'number' && priority < task.priority) task.priority = priority;
    }
    return;
  }
  if (type === 'dropPending') {
    const keep = new Set(payload.keepKeys || []);
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!keep.has(queue[i].payload.key)) {
        const [task] = queue.splice(i, 1);
        self.postMessage({ type: 'dropped', id: task.id, error: 'dropped' });
      }
    }
  }
};

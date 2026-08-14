import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { createOpfsModelCache } from './opfs-model-cache.js';

export const OPFS_KOKORO_NAMESPACE = 'kokoro-onnx-weights';

// Configure transformers cache globally for the worker
env.useBrowserCache = true;
env.allowLocalModels = false;

// NOTE: transformers.js points onnxruntime at cdn.jsdelivr.net when its backend
// module is evaluated, so the ORT runtime is fetched from there rather than
// from this origin. vite.config.js keeps the ~21 MB binary out of /assets to
// match; it used to ship on every build and never be served.
//
// Do NOT clear wasmPaths to force self-hosting. It fails silently: ORT then
// asks for `ort-wasm-simd-threaded.jsep.mjs` and `.wasm` by their canonical
// names, nothing at this origin answers to those, the wasm backend never
// initializes, and from_pretrained hangs forever with no error on both the
// WebGPU and the WASM attempt. It appears to work in dev only because
// node_modules serves the unhashed originals.
//
// Self-hosting properly means copying onnxruntime-web's dist files somewhere
// stable under their real names and pointing wasmPaths at that directory — and
// on Cloudflare Workers it is not an option at all, because the binary
// transformers-v4 needs is over the 25 MiB per-asset ceiling.

// huggingface.co omits Access-Control-Allow-Origin when a request carries a
// Referer from certain hosts — *.workers.dev among them — so every weight fetch
// fails CORS and the engine never starts. transformers.js issues those fetches
// itself with no way to configure them, so the referrer is stripped here.
// public/_headers sets Referrer-Policy: no-referrer for the same reason; this
// keeps the worker correct even when the app is served without those headers.
const HF_HOSTS = ['huggingface.co', 'hf.co', 'cdn-lfs.huggingface.co'];
const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  let isHF = false;
  try {
    isHF = !!url && HF_HOSTS.some((h) => new URL(url, self.location.href).hostname.endsWith(h));
  } catch (_e) {
    isHF = false;
  }
  return isHF ? nativeFetch(input, { ...init, referrerPolicy: 'no-referrer' }) : nativeFetch(input, init);
};

let tts = null;
let availableVoices = null;
let fallbackVoiceId = 'af_heart';

/**
 * Pending synthesis tasks, ordered by (priority, seq) at pick time rather than
 * strict FIFO. The line the listener is about to hear always outranks lookahead
 * work, which is what keeps a seek from queueing behind eight future lines.
 */
const queue = [];
let seqCounter = 0;
let isProcessing = false;

self.onmessage = (e) => {
  const { type, id, payload } = e.data || {};

  switch (type) {
    case 'init':
      handleInit(id, payload);
      break;

    case 'generate':
      queue.push({
        id,
        key: payload.key,
        payload,
        priority: typeof payload.priority === 'number' ? payload.priority : 1000,
        seq: seqCounter++,
      });
      pump();
      break;

    case 'reprioritize': {
      const priorities = payload.priorities || {};
      for (const task of queue) {
        const next = priorities[task.key];
        if (typeof next === 'number' && next < task.priority) {
          task.priority = next;
        }
      }
      break;
    }

    // Drop *pending* work only. Whatever is already generating runs to completion
    // and is still delivered — the main thread caches it, so it is never wasted.
    case 'dropPending': {
      const keep = new Set(payload && payload.keepKeys ? payload.keepKeys : []);
      for (let i = queue.length - 1; i >= 0; i--) {
        if (!keep.has(queue[i].key)) {
          const [dropped] = queue.splice(i, 1);
          self.postMessage({ type: 'dropped', id: dropped.id, error: 'dropped' });
        }
      }
      break;
    }

    default:
      break;
  }
};

async function handleInit(id, payload) {
  const modelId = payload.modelId;
  const progress_callback = (p) => {
    if (p && typeof p.progress === 'number') {
      self.postMessage({ type: 'progress', payload: p });
    }
  };

  try {
    const cache = await createOpfsModelCache(OPFS_KOKORO_NAMESPACE);
    if (cache) {
      env.useCustomCache = true;
      env.customCache = cache;
      env.useBrowserCache = false;
    } else {
      env.useBrowserCache = true;
    }
  } catch (_) {
    env.useBrowserCache = true;
  }

  // Kokoro-82M on WASM (SIMD) with quantized q8 weights is fast (<0.3x RTF) and
  // produces pristine, crystal-clear neural speech without WebGPU shader precision glitches.
  const attempts = [];
  if (payload.device === 'webgpu' && typeof navigator !== 'undefined' && navigator.gpu) {
    attempts.push({ device: 'webgpu', dtype: 'fp32' });
  }
  attempts.push({ device: 'wasm', dtype: 'q8' });
  if (payload.dtype === 'fp32') {
    attempts.push({ device: 'wasm', dtype: 'fp32' });
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      tts = await KokoroTTS.from_pretrained(modelId, {
        dtype: attempt.dtype,
        device: attempt.device,
        progress_callback,
      });

      availableVoices = tts.voices ? new Set(Object.keys(tts.voices)) : null;
      if (availableVoices && !availableVoices.has(fallbackVoiceId)) {
        fallbackVoiceId = availableVoices.values().next().value || fallbackVoiceId;
      }

      self.postMessage({
        type: 'init_complete',
        id,
        payload: { success: true, device: attempt.device, dtype: attempt.dtype },
      });
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Kokoro init failed on ${attempt.device}:`, error);
    }
  }

  self.postMessage({
    type: 'error',
    id,
    error: (lastError && lastError.message) || 'Kokoro initialization failed',
  });
}

function takeNextTask() {
  if (queue.length === 0) return null;

  let bestIndex = 0;
  for (let i = 1; i < queue.length; i++) {
    const candidate = queue[i];
    const best = queue[bestIndex];
    if (candidate.priority < best.priority || (candidate.priority === best.priority && candidate.seq < best.seq)) {
      bestIndex = i;
    }
  }

  return queue.splice(bestIndex, 1)[0];
}

async function pump() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    let task = takeNextTask();
    while (task !== null) {
      const { id, payload } = task;

      try {
        if (!tts) throw new Error('TTS engine not initialized');

        const { text, voiceId, speed } = payload;
        // An unknown voice id would otherwise throw and stall the whole read.
        const voice = availableVoices && !availableVoices.has(voiceId) ? fallbackVoiceId : voiceId;

        const rawAudio = await tts.generate(text, { voice, speed });
        const samples = rawAudio.audio;

        self.postMessage(
          {
            type: 'generate_complete',
            id,
            payload: {
              key: payload.key,
              audio: samples,
              sampling_rate: rawAudio.sampling_rate || 24000,
            },
          },
          [samples.buffer],
        );
      } catch (error) {
        self.postMessage({
          type: 'error',
          id,
          error: (error && error.message) || 'Unknown worker error',
        });
      }
      task = takeNextTask();
    }
  } finally {
    isProcessing = false;
  }

  // A task may have arrived while the loop was unwinding.
  if (queue.length > 0) pump();
}

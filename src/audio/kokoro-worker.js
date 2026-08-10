import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

// Configure transformers cache globally for the worker
env.useBrowserCache = true;
env.allowLocalModels = false;

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
        seq: seqCounter++
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

  // WebGPU is several times faster than WASM and is what keeps lookahead ahead of
  // playback on long scripts. Fall back silently when it is missing or unusable.
  const attempts = [];
  if (payload.device !== 'wasm' && typeof navigator !== 'undefined' && navigator.gpu) {
    attempts.push({ device: 'webgpu', dtype: 'fp32' });
  }
  attempts.push({ device: 'wasm', dtype: 'q8' });

  let lastError = null;
  for (const attempt of attempts) {
    try {
      tts = await KokoroTTS.from_pretrained(modelId, {
        dtype: attempt.dtype,
        device: attempt.device,
        progress_callback
      });

      availableVoices = tts.voices ? new Set(Object.keys(tts.voices)) : null;
      if (availableVoices && !availableVoices.has(fallbackVoiceId)) {
        fallbackVoiceId = availableVoices.values().next().value || fallbackVoiceId;
      }

      self.postMessage({
        type: 'init_complete',
        id,
        payload: { success: true, device: attempt.device, dtype: attempt.dtype }
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
    error: (lastError && lastError.message) || 'Kokoro initialization failed'
  });
}

function takeNextTask() {
  if (queue.length === 0) return null;

  let bestIndex = 0;
  for (let i = 1; i < queue.length; i++) {
    const candidate = queue[i];
    const best = queue[bestIndex];
    if (candidate.priority < best.priority ||
        (candidate.priority === best.priority && candidate.seq < best.seq)) {
      bestIndex = i;
    }
  }

  return queue.splice(bestIndex, 1)[0];
}

async function pump() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    let task;
    while ((task = takeNextTask()) !== null) {
      const { id, payload } = task;

      try {
        if (!tts) throw new Error('TTS engine not initialized');

        const { text, voiceId, speed } = payload;
        // An unknown voice id would otherwise throw and stall the whole read.
        const voice = availableVoices && !availableVoices.has(voiceId) ? fallbackVoiceId : voiceId;

        const rawAudio = await tts.generate(text, { voice, speed });
        const samples = rawAudio.audio;

        self.postMessage({
          type: 'generate_complete',
          id,
          payload: {
            key: payload.key,
            audio: samples,
            sampling_rate: rawAudio.sampling_rate || 24000
          }
        }, [samples.buffer]);
      } catch (error) {
        self.postMessage({
          type: 'error',
          id,
          error: (error && error.message) || 'Unknown worker error'
        });
      }
    }
  } finally {
    isProcessing = false;
  }

  // A task may have arrived while the loop was unwinding.
  if (queue.length > 0) pump();
}

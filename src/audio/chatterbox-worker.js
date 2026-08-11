import { ChatterboxModel, AutoProcessor, Tensor, env } from 'transformers-v4';

const MODEL_ID = 'onnx-community/chatterbox-ONNX';

env.useBrowserCache = true;
env.allowLocalModels = false;

const HF_HOSTS = ['huggingface.co', 'hf.co', 'cdn-lfs.huggingface.co'];
const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input?.url);
  let isHuggingFace = false;
  try {
    isHuggingFace = !!url && HF_HOSTS.some(host => new URL(url, self.location.href).hostname.endsWith(host));
  } catch (_) {
    isHuggingFace = false;
  }
  return isHuggingFace
    ? nativeFetch(input, { ...init, referrerPolicy: 'no-referrer' })
    : nativeFetch(input, init);
};

const DTYPE_CONFIGS = {
  wasm: {
    embed_tokens: 'fp32',
    speech_encoder: 'fp32',
    language_model: 'q4',
    conditional_decoder: 'fp32'
  },
  webgpu: {
    embed_tokens: 'fp32',
    speech_encoder: 'fp32',
    language_model: 'q4f16',
    conditional_decoder: 'fp32'
  }
};

let model = null;
let processor = null;
let device = null;
const speakers = new Map();
const queue = [];
let sequence = 0;
let processing = false;

function postError(id, error) {
  self.postMessage({ type: 'error', id, error: error?.message || 'Studio voice generation failed.' });
}

async function hasWebGpu() {
  if (!navigator.gpu) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch (_) {
    return false;
  }
}

async function initialize(id, payload = {}) {
  try {
    const webgpu = await hasWebGpu();
    device = payload.device === 'wasm' ? 'wasm' : (webgpu ? 'webgpu' : 'wasm');
    const dtype = DTYPE_CONFIGS[device];
    processor = await AutoProcessor.from_pretrained(MODEL_ID);
    model = await ChatterboxModel.from_pretrained(MODEL_ID, {
      device,
      dtype,
      progress_callback: progress => self.postMessage({ type: 'progress', payload: progress })
    });
    self.postMessage({ type: 'init_complete', id, payload: { device, dtype } });
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
  const inputs = await processor._call(task.payload.text);
  const waveform = await model.generate({
    ...inputs,
    ...speakers.get(task.payload.voiceId),
    exaggeration: task.payload.exaggeration ?? 0.5,
    max_new_tokens: 256
  });
  const samples = waveform.data instanceof Float32Array
    ? waveform.data
    : new Float32Array(waveform.data);
  const output = samples.slice();
  self.postMessage({
    type: 'generate_complete',
    id: task.id,
    payload: { audio: output, sampling_rate: 24000 }
  }, [output.buffer]);
}

function takeNext() {
  if (queue.length === 0) return null;
  let best = 0;
  for (let i = 1; i < queue.length; i++) {
    if (queue[i].priority < queue[best].priority ||
        (queue[i].priority === queue[best].priority && queue[i].sequence < queue[best].sequence)) {
      best = i;
    }
  }
  return queue.splice(best, 1)[0];
}

async function pump() {
  if (processing) return;
  processing = true;
  try {
    let task;
    while ((task = takeNext())) {
      try {
        await generate(task);
      } catch (error) {
        postError(task.id, error);
      }
    }
  } finally {
    processing = false;
  }
  if (queue.length) pump();
}

self.onmessage = event => {
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

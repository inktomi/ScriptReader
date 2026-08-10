import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

// Configure transformers cache globally for the worker
env.useBrowserCache = true;
env.allowLocalModels = false;

let tts = null;
let interruptToken = 0;

const messageQueue = [];
let isProcessing = false;

self.onmessage = (e) => {
  const { type, id, payload } = e.data;

  if (type === 'stop') {
    interruptToken++;
    messageQueue.length = 0;
    return;
  }

  if (type === 'init') {
    const { modelId, device } = payload;
    
    KokoroTTS.from_pretrained(modelId, {
      dtype: 'q8',
      device: device || 'wasm',
      progress_callback: (p) => {
        if (p && typeof p.progress === 'number') {
          self.postMessage({ type: 'progress', payload: p });
        }
      }
    }).then(loadedTts => {
      tts = loadedTts;
      self.postMessage({ type: 'init_complete', id, payload: { success: true } });
    }).catch(error => {
      self.postMessage({ type: 'error', id, error: error.message });
    });
  } 
  else if (type === 'generate') {
    messageQueue.push({ id, payload, tokenAtQueueTime: interruptToken });
    processQueue();
  }
};

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (messageQueue.length > 0) {
    const { id, payload, tokenAtQueueTime } = messageQueue.shift();

    if (tokenAtQueueTime !== interruptToken) {
      self.postMessage({ type: 'error', id, error: 'interrupted' });
      continue;
    }

    try {
      if (!tts) throw new Error('TTS engine not initialized');

      const { text, voiceId, speed } = payload;
      const rawAudio = await tts.generate(text, { voice: voiceId, speed });

      if (tokenAtQueueTime !== interruptToken) {
        self.postMessage({ type: 'error', id, error: 'interrupted' });
        continue;
      }

      self.postMessage({
        type: 'generate_complete',
        id,
        payload: {
          audio: rawAudio.audio,
          sampling_rate: rawAudio.sampling_rate || 24000
        }
      }, [rawAudio.audio.buffer]);

    } catch (error) {
      self.postMessage({ type: 'error', id, error: error.message || 'Unknown worker error' });
    }
  }

  isProcessing = false;
}

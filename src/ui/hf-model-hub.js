import { getIconSvg } from '../utils/icons.js';
import { ModelCacheManager, DEFAULT_MODEL_ID, ALL_KOKORO_VOICE_IDS } from '../audio/model-cache-manager.js';

export const HF_TTS_MODELS = [
  {
    id: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    name: 'Kokoro-82M v1.0 (ONNX)',
    author: 'hexgrad & ONNX Community',
    hfUrl: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
    params: '82M Parameters',
    license: 'Apache 2.0',
    status: 'Ready / Supported in-Browser (WASM/WebGPU)',
    badgeColor: '#10B981',
    description: 'State-of-the-art lightweight neural TTS model with outstanding prosody, human-like cadence, and 20+ built-in character voices.',
    features: ['28 Male/Female/Elder Voices', 'Emotion Prosody Control', 'Sub-second Inference', 'Zero Cloud Required'],
    isRecommended: true
  },
  {
    id: 'Xenova/speecht5_tts',
    name: 'SpeechT5 TTS',
    author: 'Microsoft & Xenova',
    hfUrl: 'https://huggingface.co/Xenova/speecht5_tts',
    params: '150M Parameters',
    license: 'MIT',
    status: 'Supported in Transformers.js',
    badgeColor: '#06B6D4',
    description: 'Unified modal speech-to-speech / text-to-speech encoder-decoder architecture with X-vector speaker embeddings.',
    features: ['Speaker Embedding Conditioning', 'Multi-speaker support', 'Transformers.js pipeline'],
    isRecommended: false
  },
  {
    id: 'suno/bark-small',
    name: 'Bark (Small / Generative)',
    author: 'Suno AI',
    hfUrl: 'https://huggingface.co/suno/bark-small',
    params: 'Small / Medium',
    license: 'MIT',
    status: 'Non-Verbal / Emotion Specialized',
    badgeColor: '#F59E0B',
    description: 'Transformer-based audio generation model famous for expressive vocalizations: laughs [laughs], sighs [sighs], whispers, and crying.',
    features: ['Non-verbal vocalizations', 'Laughter & Gasps', 'Music & Ambient sounds'],
    isRecommended: false
  },
  {
    id: 'parler-tts/parler-tts-mini-v1',
    name: 'Parler-TTS Mini',
    author: 'Parler-TTS & Hugging Face',
    hfUrl: 'https://huggingface.co/parler-tts/parler-tts-mini-v1',
    params: '600M Parameters',
    license: 'Apache 2.0',
    status: 'Natural Language Prompted TTS',
    badgeColor: '#8B5CF6',
    description: 'Controllable text-to-speech where voice style, room acoustics, and emotional tone are guided by natural language prompts.',
    features: ['Prompt-controlled tone & pacing', 'High fidelity audio', 'Gender/Age conditioning'],
    isRecommended: false
  },
  {
    id: 'facebook/mms-tts-eng',
    name: 'Meta MMS-TTS (VITS)',
    author: 'Meta AI',
    hfUrl: 'https://huggingface.co/facebook/mms-tts-eng',
    params: '35M Parameters',
    license: 'CC-BY-NC 4.0',
    status: 'Ultra Lightweight VITS',
    badgeColor: '#F43F5E',
    description: 'Massively Multilingual Speech (MMS) project model based on VITS end-to-end architecture for fast speech synthesis.',
    features: ['End-to-end VITS', 'Ultra low memory footprint', 'High speed'],
    isRecommended: false
  }
];

export function createHfModelHubModal({ currentModelId, onSelectModel, onClose }) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  modal.innerHTML = `
    <div class="modal-card" style="max-width: 820px;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.5rem;">🤗</span>
          <div>
            <h2 style="font-size: 1.15rem; font-weight: 700; color: #FFFFFF;">Local Model & Neural Engine Hub</h2>
            <div style="font-size: 0.75rem; color: var(--text-secondary);">
              Manage local on-device neural voice models, persistent caching & offline storage
            </div>
          </div>
        </div>
        <button class="btn-icon btn-close-modal">
          ${getIconSvg('close', 18)}
        </button>
      </div>

      <div class="modal-body" style="display: flex; flex-direction: column; gap: 16px;">
        <!-- Local Model Cache & Storage Status Card -->
        <div class="model-cache-card" id="model-cache-container" style="background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 12px; padding: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.35);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 1.3rem;">💾</span>
              <div>
                <div style="font-size: 0.95rem; font-weight: 700; color: #FFFFFF; display: flex; align-items: center; gap: 8px;">
                  <span>Kokoro-82M Local Cache Status</span>
                  <span id="cache-overall-badge" class="badge-voice" style="background: rgba(16, 185, 129, 0.2); color: #10B981;">Checking...</span>
                </div>
                <div id="storage-persist-sub" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                  Checking persistent storage quota...
                </div>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 8px;">
              <button id="btn-preload-all" class="btn btn-primary" style="padding: 6px 12px; font-size: 0.75rem; font-weight: 600;">
                <span>⚡ Preload & Cache All</span>
              </button>
              <button id="btn-clear-cache" class="btn btn-secondary" style="padding: 6px 12px; font-size: 0.75rem; color: var(--text-muted);">
                <span>Clear Cache</span>
              </button>
            </div>
          </div>

          <!-- Metrics Grid -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 12px;">
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-glass); border-radius: 8px; padding: 10px 12px;">
              <div style="font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">ONNX Model Weights</div>
              <div id="metric-model-weights" style="font-size: 0.9rem; font-weight: 700; color: #F8FAFC; margin-top: 4px;">Loading...</div>
            </div>
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-glass); border-radius: 8px; padding: 10px 12px;">
              <div style="font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Neural Character Voices</div>
              <div id="metric-voices-count" style="font-size: 0.9rem; font-weight: 700; color: #06B6D4; margin-top: 4px;">0 / 28 Cached</div>
            </div>
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-glass); border-radius: 8px; padding: 10px 12px;">
              <div style="font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Browser Persistence</div>
              <div id="metric-storage-mode" style="font-size: 0.9rem; font-weight: 700; color: #10B981; margin-top: 4px;">Persistent</div>
            </div>
          </div>

          <!-- Preload Progress Container -->
          <div id="cache-progress-container" style="display: none; background: rgba(0, 0, 0, 0.3); border: 1px solid var(--border-glass); border-radius: 8px; padding: 10px; margin-top: 8px;">
            <div style="display: flex; justify-content: space-between; font-size: 0.75rem; font-weight: 600; color: #06B6D4; margin-bottom: 6px;">
              <span id="cache-progress-msg">Downloading model files...</span>
              <span id="cache-progress-pct">0%</span>
            </div>
            <div class="neural-progress-bar" style="height: 6px;">
              <div class="neural-progress-fill" id="cache-progress-fill" style="width: 0%;"></div>
            </div>
          </div>

          <div style="font-size: 0.75rem; color: var(--text-secondary); line-height: 1.4; margin-top: 8px;">
            💡 <strong>Offline Guarantee:</strong> Once cached, Kokoro-82M ONNX model weights and all character voices run 100% on-device with zero network requests.
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 12px;">
          ${HF_TTS_MODELS.map(model => {
            const isSelected = model.id === currentModelId;
            return `
              <div class="character-card" style="border-color: ${isSelected ? '#F59E0B' : 'var(--border-glass)'}; background: ${isSelected ? 'rgba(245, 158, 11, 0.06)' : 'var(--bg-panel-glass)'};">
                <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;">
                  <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                      <span style="font-weight: 700; font-size: 1rem; color: #FFFFFF;">${model.name}</span>
                      ${model.isRecommended ? `<span class="badge-voice" style="background: rgba(16, 185, 129, 0.2); color: #10B981;">★ Active & Recommended</span>` : ''}
                      <span class="badge-lines">${model.params}</span>
                      <span class="badge-lines">${model.license}</span>
                    </div>

                    <p style="font-size: 0.8rem; color: var(--text-secondary); margin: 6px 0 10px 0; line-height: 1.4;">
                      ${model.description}
                    </p>

                    <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                      ${model.features.map(f => `
                        <span style="font-size: 0.7rem; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); padding: 2px 6px; border-radius: 4px; color: var(--text-script);">
                          ✓ ${f}
                        </span>
                      `).join('')}
                    </div>
                  </div>

                  <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex-shrink: 0;">
                    <a href="${model.hfUrl}" target="_blank" class="btn btn-secondary" style="padding: 6px 12px; font-size: 0.75rem; text-decoration: none;" title="Open Model Card on Hugging Face">
                      🤗 View on HF
                    </a>
                    ${model.id === 'onnx-community/Kokoro-82M-v1.0-ONNX' ? `
                      <button class="btn btn-primary btn-select-hf" data-model="${model.id}" style="padding: 6px 12px; font-size: 0.75rem;">
                        ${isSelected ? '✓ Active Model' : 'Use This Model'}
                      </button>
                    ` : `
                      <span style="font-size: 0.7rem; color: var(--text-muted);">Available in SDK</span>
                    `}
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;

  // Update Cache UI helper
  async function refreshCacheUI() {
    try {
      const status = await ModelCacheManager.getModelCacheStatus(DEFAULT_MODEL_ID);
      const estimate = await ModelCacheManager.getStorageEstimate();

      const badge = modal.querySelector('#cache-overall-badge');
      const modelMetric = modal.querySelector('#metric-model-weights');
      const voicesMetric = modal.querySelector('#metric-voices-count');
      const storageMetric = modal.querySelector('#metric-storage-mode');
      const persistSub = modal.querySelector('#storage-persist-sub');

      if (badge) {
        if (status.isFullyCached) {
          badge.textContent = `✓ 100% Cached Locally (${status.formattedSize})`;
          badge.style.background = 'rgba(16, 185, 129, 0.2)';
          badge.style.color = '#10B981';
        } else if (status.isModelCached) {
          badge.textContent = `⚡ Model Cached (${status.formattedSize}) • Voices caching...`;
          badge.style.background = 'rgba(6, 182, 212, 0.2)';
          badge.style.color = '#06B6D4';
        } else {
          badge.textContent = 'Not Cached (Ready to download)';
          badge.style.background = 'rgba(245, 158, 11, 0.2)';
          badge.style.color = '#F59E0B';
        }
      }

      if (modelMetric) {
        modelMetric.textContent = status.isModelCached ? `✓ Cached (${status.formattedSize})` : 'Not Cached';
        modelMetric.style.color = status.isModelCached ? '#10B981' : '#F59E0B';
      }

      if (voicesMetric) {
        voicesMetric.textContent = `${status.cachedVoiceCount} / ${status.totalVoices} Cached`;
        voicesMetric.style.color = status.cachedVoiceCount >= status.totalVoices ? '#10B981' : '#06B6D4';
      }

      if (storageMetric) {
        storageMetric.textContent = estimate.persisted ? '✓ Persistent' : 'Best-Effort';
        storageMetric.style.color = estimate.persisted ? '#10B981' : '#94A3B8';
      }

      if (persistSub) {
        persistSub.textContent = `Storage usage: ${estimate.usageFormatted} of ${estimate.quotaFormatted} allocated quota`;
      }
    } catch (e) {
      console.warn('Cache UI refresh notice:', e);
    }
  }

  // Preload All Handler
  const preloadBtn = modal.querySelector('#btn-preload-all');
  const progressContainer = modal.querySelector('#cache-progress-container');
  const progressMsg = modal.querySelector('#cache-progress-msg');
  const progressPct = modal.querySelector('#cache-progress-pct');
  const progressFill = modal.querySelector('#cache-progress-fill');

  preloadBtn.addEventListener('click', async () => {
    preloadBtn.disabled = true;
    preloadBtn.innerHTML = '<span>⏳ Downloading...</span>';
    if (progressContainer) progressContainer.style.display = 'block';

    try {
      await ModelCacheManager.preloadAllModelAssets(DEFAULT_MODEL_ID, (p) => {
        if (progressMsg) progressMsg.textContent = p.message;
        if (progressPct) progressPct.textContent = `${p.percent}%`;
        if (progressFill) progressFill.style.width = `${p.percent}%`;
      });
      await refreshCacheUI();
      preloadBtn.innerHTML = '<span>✓ Fully Cached</span>';
      setTimeout(() => {
        if (progressContainer) progressContainer.style.display = 'none';
        preloadBtn.disabled = false;
        preloadBtn.innerHTML = '<span>⚡ Re-verify Cache</span>';
      }, 2500);
    } catch (err) {
      console.error('Preload error:', err);
      if (progressMsg) progressMsg.textContent = `Preload failed: ${err.message}`;
      preloadBtn.disabled = false;
      preloadBtn.innerHTML = '<span>⚡ Retry Preload</span>';
    }
  });

  // Clear Cache Handler
  const clearBtn = modal.querySelector('#btn-clear-cache');
  clearBtn.addEventListener('click', async () => {
    if (confirm('Clear local Kokoro model cache? The model will re-download on next playback.')) {
      clearBtn.disabled = true;
      clearBtn.textContent = 'Clearing...';
      await ModelCacheManager.clearModelCache(DEFAULT_MODEL_ID);
      await refreshCacheUI();
      clearBtn.disabled = false;
      clearBtn.textContent = 'Clear Cache';
    }
  });

  // Initial UI refresh
  refreshCacheUI();

  modal.querySelector('.btn-close-modal').addEventListener('click', () => {
    modal.remove();
    if (onClose) onClose();
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
      if (onClose) onClose();
    }
  });

  modal.querySelectorAll('.btn-select-hf').forEach(btn => {
    btn.addEventListener('click', () => {
      onSelectModel(btn.dataset.model);
      modal.remove();
      if (onClose) onClose();
    });
  });

  return modal;
}


import { getIconSvg } from '../utils/icons.js';
import { SAMPLE_SCRIPTS } from '../screenplay/sample-scripts.js';
import { ENGINE_TYPES } from '../audio/audio-manager.js';

export function createHeader({
  onLoadSample,
  onOpenUpload,
  onOpenHfHub,
  onOpenVoiceConfig,
  onToggleCast,
  onToggleScenes,
  onToggleHelp,
  onEngineChange,
  currentEngine = ENGINE_TYPES.KOKORO_NEURAL
}) {
  const header = document.createElement('header');
  header.className = 'app-header';

  const samplesOptions = SAMPLE_SCRIPTS.map(s => 
    `<option value="${s.id}">${s.title} (${s.genre})</option>`
  ).join('');

  header.innerHTML = `
    <div class="header-brand">
      <div class="brand-badge">
        ${getIconSvg('film', 22)}
      </div>
      <div>
        <div class="brand-title">
          ScriptReader <span class="brand-tag">PRO</span>
        </div>
      </div>
    </div>

    <div class="header-actions">
      <!-- Sample Screenplay Picker -->
      <div style="display: flex; align-items: center; gap: 8px;">
        <select id="sample-script-select" class="voice-select" style="min-width: 200px; font-weight: 500;">
          <option value="" disabled selected>✨ Load Sample Script...</option>
          ${samplesOptions}
        </select>
      </div>

      <!-- Import PDF / Script Button -->
      <button id="btn-import-script" class="btn btn-secondary">
        ${getIconSvg('upload', 16)}
        <span>Import Script</span>
      </button>

      <!-- Voice Cast Setup Button -->
      <button id="btn-voice-setup" class="btn btn-primary" title="Configure and test character voices for this script">
        ${getIconSvg('sparkles', 15)}
        <span>Voice Cast Setup</span>
      </button>

      <!-- Hugging Face Models Hub -->
      <button id="btn-hf-hub" class="btn btn-secondary" title="Explore Hugging Face Open-Source TTS Models">
        <span>🤗 Models</span>
      </button>

      <!-- Neural Engine Status Badge -->
      <div class="engine-badge active" id="engine-status-badge" style="cursor: pointer;" title="Kokoro-82M High-Fidelity Local Neural Voice Engine (Click to view local cache & model hub)">
        ${getIconSvg('cpu', 14)}
        <span id="engine-badge-text">Kokoro Neural</span>
      </div>

      <!-- Sidebar Toggle Buttons -->
      <button id="btn-toggle-cast" class="btn btn-secondary btn-active" title="Toggle Cast Studio (C)">
        ${getIconSvg('users', 16)}
        <span>Cast</span>
      </button>

      <button id="btn-toggle-scenes" class="btn btn-secondary" title="Scene Index (S)">
        ${getIconSvg('layers', 16)}
        <span>Scenes</span>
      </button>

      <!-- Help Button -->
      <button id="btn-help" class="btn-icon" title="Keyboard Shortcuts & Help (?)">
        ${getIconSvg('help', 18)}
      </button>
    </div>
  `;

  // Attach event listeners
  const sampleSelect = header.querySelector('#sample-script-select');
  sampleSelect.addEventListener('change', (e) => {
    if (e.target.value) {
      onLoadSample(e.target.value);
      e.target.blur();
    }
  });

  header.querySelector('#btn-import-script').addEventListener('click', onOpenUpload);
  header.querySelector('#btn-voice-setup').addEventListener('click', onOpenVoiceConfig);
  header.querySelector('#btn-hf-hub').addEventListener('click', onOpenHfHub);
  header.querySelector('#engine-status-badge').addEventListener('click', onOpenHfHub);
  header.querySelector('#btn-toggle-cast').addEventListener('click', onToggleCast);
  header.querySelector('#btn-toggle-scenes').addEventListener('click', onToggleScenes);
  header.querySelector('#btn-help').addEventListener('click', onToggleHelp);

  function setSelectedSample(sampleId) {
    if (sampleSelect) {
      sampleSelect.value = sampleId || '';
    }
  }

  function updateEngineCacheBadge({ isCached, formattedSize, isFullyCached }) {
    const badgeText = header.querySelector('#engine-badge-text');
    const badge = header.querySelector('#engine-status-badge');
    if (badgeText && badge) {
      if (isFullyCached || isCached) {
        badgeText.textContent = `⚡ Kokoro (Local Cache)`;
        badge.style.color = '#10B981';
        badge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        badge.style.background = 'rgba(16, 185, 129, 0.12)';
        badge.title = `Kokoro-82M ONNX model cached locally (${formattedSize}) • 28/28 Voices Ready • Offline Capable`;
      } else {
        badgeText.textContent = `Kokoro Neural`;
        badge.style.color = '#06B6D4';
        badge.style.borderColor = 'rgba(6, 182, 212, 0.25)';
        badge.style.background = 'rgba(6, 182, 212, 0.08)';
        badge.title = `Kokoro-82M Neural Engine (Click to view local cache)`;
      }
    }
  }

  return {
    element: header,
    setSelectedSample,
    updateEngineCacheBadge
  };
}

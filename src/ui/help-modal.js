import { getIconSvg } from '../utils/icons.js';

export function createHelpModal({ onClose }) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  modal.innerHTML = `
    <div class="modal-card" style="max-width: 640px;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.25rem;">✨</span>
          <h2 style="font-size: 1.15rem; font-weight: 700; color: #FFFFFF;">ScriptReader Pro Guide</h2>
        </div>
        <button class="btn-icon btn-close-modal">
          ${getIconSvg('close', 18)}
        </button>
      </div>

      <div class="modal-body" style="display: flex; flex-direction: column; gap: 20px;">
        <div>
          <h3 style="font-size: 0.95rem; font-weight: 700; color: #F59E0B; margin-bottom: 8px;">
            🎙️ Kokoro Neural 82M Speech Engine
          </h3>
          <p style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
            State-of-the-art open-source neural TTS running locally in your browser with ONNX & WebAssembly/WebGPU. Delivers 20+ distinct, studio-quality human voices with lookahead pre-buffering for gapless table reads.
          </p>
        </div>

        <div>
          <h3 style="font-size: 0.95rem; font-weight: 700; color: #06B6D4; margin-bottom: 8px;">
            🎭 Emotion & Direction Recognition
          </h3>
          <p style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
            The engine automatically recognizes parentheticals like <code>(whispering)</code>, <code>(angry)</code>, <code>(sobbing)</code>, <code>(beat)</code>, <code>(sarcastic)</code>, and modulates voice pitch, cadence, pauses, and volume dynamically.
          </p>
        </div>

        <div>
          <h3 style="font-size: 0.95rem; font-weight: 700; color: #F43F5E; margin-bottom: 8px;">
            ⌨️ Keyboard Shortcuts
          </h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.8rem; font-family: var(--font-mono);">
            <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-glass);">
              <strong style="color: #F59E0B;">Spacebar:</strong> Play / Pause
            </div>
            <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-glass);">
              <strong style="color: #F59E0B;">Left Arrow:</strong> Previous Line
            </div>
            <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-glass);">
              <strong style="color: #F59E0B;">Right Arrow:</strong> Next Line
            </div>
            <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-glass);">
              <strong style="color: #F59E0B;">C Key:</strong> Toggle Cast Studio
            </div>
            <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-glass);">
              <strong style="color: #F59E0B;">S Key:</strong> Toggle Scenes Drawer
            </div>
            <div style="background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-glass);">
              <strong style="color: #F59E0B;">? Key:</strong> Open this Help Guide
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

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

  return modal;
}

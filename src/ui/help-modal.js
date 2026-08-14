import { getIconSvg } from '../utils/icons.js';

export function createHelpModal({ onClose }) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  modal.innerHTML = `
    <div class="modal-card" style="max-width: 640px;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 10px;">
          ${getIconSvg('book', 18)}
          <h2 style="font-size: 1.15rem; font-weight: 700;">ScriptReader guide</h2>
        </div>
        <button class="btn-icon btn-close-modal" aria-label="Close guide">
          ${getIconSvg('close', 18)}
        </button>
      </div>

      <div class="modal-body help-sections">
        <section>
          <h3>${getIconSvg('cpu', 16)} Private by default</h3>
          <p>Kokoro provides fast local playback. Studio Local installs Chatterbox once and creates higher-quality private voices from reference recordings stored on this device. If you choose OpenAI voices, ScriptReader clearly asks for consent before sending dialogue for synthesis.</p>
        </section>

        <section>
          <h3>${getIconSvg('sliders', 16)} Direction-aware performances</h3>
          <p>Parentheticals such as <code>(whispering)</code>, <code>(angry)</code>, and <code>(beat)</code> shape cadence, pitch, pause, and level. Character settings can add more specific direction.</p>
        </section>

        <section>
          <h3>${getIconSvg('book', 16)} Keyboard shortcuts</h3>
          <div class="shortcut-grid">
            <span><kbd>Space</kbd> Play or pause</span>
            <span><kbd>←</kbd> Previous line</span>
            <span><kbd>→</kbd> Next line</span>
            <span><kbd>C</kbd> Open cast library</span>
            <span><kbd>S</kbd> Open scene library</span>
            <span><kbd>V</kbd> Edit voice cast</span>
            <span><kbd>?</kbd> Open this guide</span>
          </div>
        </section>
      </div>
    </div>
  `;

  const close = () => {
    modal.remove();
    if (onClose) onClose();
  };
  modal.querySelector('.btn-close-modal').addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });

  return modal;
}

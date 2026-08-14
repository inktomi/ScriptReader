import { SAMPLE_SCRIPTS } from '../screenplay/sample-scripts.js';
import { escapeHtml } from '../utils/escape-html.js';
import { getIconSvg } from '../utils/icons.js';

const ESTIMATED_MINUTES = {
  'neon-heist': 5,
  'midnight-manor': 5,
  crossfire: 2,
};

export function createWelcomeScreen({
  recentScript = null,
  onFileSelected,
  onPasteSubmitted,
  onSelectSample,
  onContinueRecent,
  onOpenHelp,
}) {
  const screen = document.createElement('main');
  screen.className = 'welcome-screen';

  screen.innerHTML = `
    <header class="welcome-header">
      <a class="wordmark" href="#" aria-label="ScriptReader home">
        <span class="wordmark-mark">${getIconSvg('book', 18)}</span>
        <span>ScriptReader</span>
      </a>
      <button class="btn btn-quiet welcome-help" type="button">
        ${getIconSvg('help', 16)}
        <span>Help</span>
      </button>
    </header>

    <section class="welcome-hero" aria-labelledby="welcome-title">
      <div class="eyebrow">Private screenplay table reads</div>
      <h1 id="welcome-title">Hear your screenplay performed.</h1>
      <p>Cast distinct voices, follow every scene, and listen at the pace your story deserves.</p>
    </section>

    <section class="script-entry-grid" aria-label="Choose a screenplay">
      <div class="upload-panel">
        <input id="welcome-file-input" type="file" accept=".pdf,.fountain,.txt" hidden>
        <button class="welcome-dropzone" id="welcome-dropzone" type="button">
          <span class="dropzone-icon">${getIconSvg('upload', 24)}</span>
          <span class="dropzone-title">Upload a screenplay</span>
          <span class="dropzone-copy">Drop a PDF, Fountain, or text file here</span>
          <span class="btn btn-primary dropzone-button">Choose a file</span>
        </button>
        <div class="upload-meta">
          <span>${getIconSvg('check', 14)} Parsed on this device</span>
          <button class="text-button" id="welcome-paste-toggle" type="button">Paste screenplay text</button>
        </div>

        <form class="paste-panel" id="welcome-paste-panel" hidden>
          <label>
            <span>Title <small>optional</small></span>
            <input id="welcome-paste-title" type="text" placeholder="Untitled screenplay">
          </label>
          <label>
            <span>Screenplay text</span>
            <textarea id="welcome-paste-text" rows="8" placeholder="Paste Fountain or plain screenplay text…" required></textarea>
          </label>
          <div class="paste-actions">
            <button class="btn btn-quiet" id="welcome-paste-cancel" type="button">Cancel</button>
            <button class="btn btn-primary" type="submit">Continue to casting</button>
          </div>
        </form>
      </div>

      <div class="sample-panel">
        <div class="section-heading">
          <div>
            <div class="eyebrow">Or begin with a sample</div>
            <h2>Listen before you import</h2>
          </div>
          <span class="sample-count">${SAMPLE_SCRIPTS.length} scripts</span>
        </div>
        <div class="sample-list">
          ${SAMPLE_SCRIPTS.map(
            (sample) => `
            <button class="sample-card" type="button" data-sample-id="${escapeHtml(sample.id)}">
              <span class="sample-card-main">
                <strong>${escapeHtml(sample.title)}</strong>
                <span>${escapeHtml(sample.genre)}</span>
                <small>${escapeHtml(sample.synopsis)}</small>
              </span>
              <span class="sample-card-meta">
                <span>${sample.characterCount} voices</span>
                <span>~${ESTIMATED_MINUTES[sample.id] || 4} min</span>
                ${getIconSvg('chevronRight', 16)}
              </span>
            </button>
          `,
          ).join('')}
        </div>
      </div>
    </section>

    ${
      recentScript
        ? `
      <section class="recent-section" aria-label="Recent screenplay">
        <div>
          <span class="recent-icon">${getIconSvg('replay', 18)}</span>
          <div>
            <div class="eyebrow">Continue where you left off</div>
            <strong>${escapeHtml(recentScript.title)}</strong>
            <span>${escapeHtml(recentScript.detail)}</span>
          </div>
        </div>
        <button class="btn btn-secondary" id="welcome-continue" type="button">
          Continue script ${getIconSvg('chevronRight', 16)}
        </button>
      </section>
    `
        : ''
    }

    <footer class="welcome-footer">
      <span>${getIconSvg('cpu', 15)} Processed locally by default</span>
      <span>Your script stays in this browser unless you choose a cloud voice.</span>
    </footer>
  `;

  const fileInput = screen.querySelector('#welcome-file-input');
  const dropzone = screen.querySelector('#welcome-dropzone');
  const pastePanel = screen.querySelector('#welcome-paste-panel');
  const pasteToggle = screen.querySelector('#welcome-paste-toggle');

  const selectFile = (file) => {
    if (file && onFileSelected) onFileSelected(file);
  };

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => selectFile(fileInput.files && fileInput.files[0]));
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragging'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
    selectFile(event.dataTransfer.files && event.dataTransfer.files[0]);
  });

  pasteToggle.addEventListener('click', () => {
    pastePanel.hidden = false;
    dropzone.hidden = true;
    screen.querySelector('#welcome-paste-text').focus();
  });
  screen.querySelector('#welcome-paste-cancel').addEventListener('click', () => {
    pastePanel.hidden = true;
    dropzone.hidden = false;
  });
  pastePanel.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = screen.querySelector('#welcome-paste-text').value.trim();
    if (!text) return;
    const title = screen.querySelector('#welcome-paste-title').value.trim() || 'Untitled Screenplay';
    onPasteSubmitted(text, title);
  });

  screen.querySelectorAll('[data-sample-id]').forEach((card) => {
    card.addEventListener('click', () => onSelectSample(card.dataset.sampleId));
  });
  screen.querySelector('#welcome-continue')?.addEventListener('click', onContinueRecent);
  screen.querySelector('.welcome-help').addEventListener('click', onOpenHelp);
  screen.querySelector('.wordmark').addEventListener('click', (event) => event.preventDefault());

  return screen;
}

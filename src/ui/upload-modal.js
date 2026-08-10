import { getIconSvg } from '../utils/icons.js';

export function createUploadModal({
  onPdfSelected,
  onFountainTextSubmitted,
  onClose
}) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.25rem;">📄</span>
          <h2 style="font-size: 1.15rem; font-weight: 700; color: #FFFFFF;">Import Screenplay</h2>
        </div>
        <button class="btn-icon btn-close-modal">
          ${getIconSvg('close', 18)}
        </button>
      </div>

      <div class="modal-body">
        <!-- PDF Dropzone -->
        <div class="upload-dropzone" id="pdf-dropzone">
          <input type="file" id="file-input-pdf" accept=".pdf,.fountain,.txt" style="display: none;">
          <div class="upload-icon">
            ${getIconSvg('upload', 40)}
          </div>
          <div style="font-weight: 700; font-size: 1rem; color: #FFFFFF; margin-bottom: 4px;">
            Drop your PDF Screenplay here, or click to browse
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary);">
            Supports standard PDF screenplay exports (Final Draft, WriterDuet, Celtx, StudioBinder, Fountain)
          </div>
        </div>

        <!-- PDF Progress Status -->
        <div id="pdf-progress-area" style="display: none; margin-top: 16px;">
          <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 6px;">
            <span id="pdf-progress-msg">Extracting screenplay structure...</span>
            <span id="pdf-progress-val">0%</span>
          </div>
          <div class="neural-progress-bar">
            <div class="neural-progress-fill" id="pdf-progress-fill"></div>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 16px; margin: 24px 0;">
          <div style="flex: 1; height: 1px; background: var(--border-glass);"></div>
          <span style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Or Paste Screenplay Text</span>
          <div style="flex: 1; height: 1px; background: var(--border-glass);"></div>
        </div>

        <!-- Raw Text Paste Option -->
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <input type="text" id="paste-script-title" class="voice-select" placeholder="Screenplay Title (optional)" style="padding: 8px 12px;">
          <textarea id="paste-script-text" class="voice-select" rows="6" placeholder="Paste your screenplay text or Fountain markdown here..." style="font-family: var(--font-script); font-size: 0.85rem; line-height: 1.4; resize: vertical; padding: 12px;"></textarea>
          <button id="btn-submit-paste" class="btn btn-secondary" style="align-self: flex-end;">
            ${getIconSvg('file', 14)}
            <span>Load Pasted Text</span>
          </button>
        </div>
      </div>
    </div>
  `;

  const dropzone = modal.querySelector('#pdf-dropzone');
  const fileInput = modal.querySelector('#file-input-pdf');
  const btnClose = modal.querySelector('.btn-close-modal');
  const progressArea = modal.querySelector('#pdf-progress-area');
  const progressMsg = modal.querySelector('#pdf-progress-msg');
  const progressVal = modal.querySelector('#pdf-progress-val');
  const progressFill = modal.querySelector('#pdf-progress-fill');
  const btnSubmitPaste = modal.querySelector('#btn-submit-paste');
  const pasteTitle = modal.querySelector('#paste-script-title');
  const pasteText = modal.querySelector('#paste-script-text');

  btnClose.addEventListener('click', () => {
    modal.remove();
    if (onClose) onClose();
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
      if (onClose) onClose();
    }
  });

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '#F59E0B';
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = '';
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '';
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });

  async function handleFile(file) {
    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      progressArea.style.display = 'block';
      try {
        await onPdfSelected(file, ({ page, totalPages, percent }) => {
          progressMsg.textContent = `Extracting page ${page} of ${totalPages}...`;
          progressVal.textContent = `${percent}%`;
          progressFill.style.width = `${percent}%`;
        });
        modal.remove();
      } catch (err) {
        progressMsg.textContent = `Error reading PDF: ${err.message}`;
        progressMsg.style.color = '#EF4444';
      }
    } else {
      // Fountain / Text file
      const text = await file.text();
      onFountainTextSubmitted(text, file.name.replace(/\.[^/.]+$/, ''));
      modal.remove();
    }
  }

  btnSubmitPaste.addEventListener('click', () => {
    const text = pasteText.value.trim();
    if (text) {
      const title = pasteTitle.value.trim() || 'Custom Screenplay';
      onFountainTextSubmitted(text, title);
      modal.remove();
    }
  });

  return modal;
}

import { getIconSvg } from '../utils/icons.js';
import { escapeHtml } from '../utils/escape-html.js';
import { ENGINE_IDS } from '../audio/engine-contract.js';
import {
  loadOpenAIKey,
  saveOpenAIKey,
  clearOpenAIKey,
  maskKey,
  hasCloudConsent,
  grantCloudConsent,
  revokeCloudConsent,
  validateOpenAIKey,
  describeValidationReason
} from '../utils/credentials.js';

/**
 * Voice engine picker, consent gate, and API key entry.
 *
 * The consent step is not boilerplate. Kokoro renders on the machine and sends
 * nothing; the cloud engine sends the spoken text of every line — dialogue,
 * action, scene headings — plus whatever direction the user wrote. For an app
 * whose whole pitch is "read your unreleased screenplay privately", that is a
 * material change, and it has to be an explicit, informed choice rather than a
 * side effect of picking a nicer voice.
 */
export function createEngineSettingsModal({ audioManager, onClose, onEngineChanged, onOpenModelHub }) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  let selectedEngine = audioManager.engineId;
  let consented = hasCloudConsent();
  let validating = false;
  let validationMessage = '';
  let validationOk = null;

  const isCloud = () => selectedEngine === ENGINE_IDS.OPENAI;

  function render() {
    const storedKey = loadOpenAIKey();
    const keyReady = storedKey.length > 0;

    modal.innerHTML = `
      <div class="modal-card" style="max-width: 640px;">
        <div class="modal-header">
          <div style="display: flex; align-items: center; gap: 10px;">
            ${getIconSvg('mic', 18)}
            <h2 style="font-size: 1.15rem; font-weight: 700; color: #FFFFFF;">Voice engine</h2>
          </div>
          <button class="btn-icon btn-close-modal">${getIconSvg('close', 18)}</button>
        </div>

        <div class="modal-body" style="display: flex; flex-direction: column; gap: 16px;">

          <label class="engine-option" data-engine="${ENGINE_IDS.KOKORO}" style="
            display: block; padding: 14px; border-radius: 10px; cursor: pointer;
            border: 1px solid ${selectedEngine === ENGINE_IDS.KOKORO ? 'rgba(16,185,129,0.55)' : 'var(--border-color, rgba(255,255,255,0.12))'};
            background: ${selectedEngine === ENGINE_IDS.KOKORO ? 'rgba(16,185,129,0.08)' : 'transparent'};">
            <div style="display: flex; align-items: center; gap: 10px;">
              <input type="radio" name="engine" value="${ENGINE_IDS.KOKORO}"
                ${selectedEngine === ENGINE_IDS.KOKORO ? 'checked' : ''} style="accent-color: #10B981;">
              <span style="font-weight: 700; color: #FFFFFF;">Kokoro 82M</span>
              <span class="badge-voice" style="background: rgba(16,185,129,0.15); color: #10B981;">Local</span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px; line-height: 1.5;">
              Runs entirely in this browser. Free, works offline, and your script never
              leaves the machine. One-time model download of a few hundred megabytes.
              Quality is limited by the model's size — noticeably synthetic on long reads.
            </div>
          </label>

          ${selectedEngine === ENGINE_IDS.KOKORO && onOpenModelHub ? `
            <button id="btn-manage-local-model" class="btn btn-secondary" type="button" style="align-self:flex-start;">
              ${getIconSvg('cpu', 15)} Manage local model and cache
            </button>
          ` : ''}

          <label class="engine-option" data-engine="${ENGINE_IDS.OPENAI}" style="
            display: block; padding: 14px; border-radius: 10px; cursor: pointer;
            border: 1px solid ${isCloud() ? 'rgba(245,158,11,0.55)' : 'var(--border-color, rgba(255,255,255,0.12))'};
            background: ${isCloud() ? 'rgba(245,158,11,0.08)' : 'transparent'};">
            <div style="display: flex; align-items: center; gap: 10px;">
              <input type="radio" name="engine" value="${ENGINE_IDS.OPENAI}"
                ${isCloud() ? 'checked' : ''} style="accent-color: #F59E0B;">
              <span style="font-weight: 700; color: #FFFFFF;">OpenAI gpt-4o-mini-tts</span>
              <span class="badge-voice" style="background: rgba(245,158,11,0.15); color: #F59E0B;">Cloud · Paid</span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px; line-height: 1.5;">
              Far more natural, and takes written direction per character — "gravelly
              ex-cop, late fifties, never raises his voice". No download. Uses your own
              API key, billed to you at roughly $0.015 per minute of audio
              (about $1.80 for a feature-length script, rendered once).
            </div>
          </label>

          ${isCloud() ? `
            <div style="border-top: 1px solid rgba(255,255,255,0.08); padding-top: 16px; display: flex; flex-direction: column; gap: 12px;">

              <label style="display: flex; gap: 10px; align-items: flex-start; cursor: pointer;
                            padding: 12px; border-radius: 8px; background: rgba(245,158,11,0.06);
                            border: 1px solid rgba(245,158,11,0.25);">
                <input type="checkbox" id="cloud-consent" ${consented ? 'checked' : ''}
                       style="accent-color: #F59E0B; margin-top: 2px;">
                <span style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.55;">
                  I understand that in cloud mode the spoken text of every line — dialogue,
                  action, and scene headings — is sent to OpenAI's servers to be rendered,
                  along with any direction I write. <strong style="color:#FFFFFF;">Kokoro sends nothing.</strong>
                </span>
              </label>

              <div>
                <label style="font-size: 0.78rem; font-weight: 700; color: var(--text-muted);
                              text-transform: uppercase; letter-spacing: 0.06em;">
                  OpenAI API key
                </label>
                <div style="display: flex; gap: 8px; margin-top: 6px;">
                  <input type="password" id="openai-key-input"
                    class="voice-select" style="flex: 1; font-family: var(--font-mono); font-size: 0.8rem;"
                    placeholder="sk-proj-…"
                    autocomplete="off" spellcheck="false"
                    ${consented ? '' : 'disabled'}
                    value="${escapeHtml(storedKey)}">
                  <button id="btn-reveal-key" class="btn btn-secondary" style="padding: 6px 10px;"
                          ${consented ? '' : 'disabled'} title="Show key">${getIconSvg('eye', 15)}</button>
                  <button id="btn-test-key" class="btn btn-secondary" style="white-space: nowrap;"
                          ${consented ? '' : 'disabled'}>
                    ${validating ? 'Testing…' : 'Test key'}
                  </button>
                </div>

                ${keyReady && !validationMessage ? `
                  <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 6px;">
                    Stored: <code>${escapeHtml(maskKey(storedKey))}</code>
                  </div>` : ''}

                ${validationMessage ? `
                  <div style="font-size: 0.78rem; margin-top: 6px; color: ${validationOk ? '#10B981' : '#F87171'};">
                    ${escapeHtml(validationMessage)}
                  </div>` : ''}

                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 10px; line-height: 1.5;">
                  The key is stored in this browser's local storage, which any script on this
                  page can read. Use a <strong>project-scoped key with a spend limit</strong> set in
                  your OpenAI dashboard — that is the only protection that still holds if this
                  site is ever compromised.
                </div>
              </div>

              ${keyReady ? `
                <button id="btn-forget-key" class="btn btn-secondary" style="align-self: flex-start; font-size: 0.75rem; padding: 5px 10px;">
                  Forget this key
                </button>` : ''}
            </div>
          ` : ''}
        </div>

        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="btn-engine-cancel" class="btn btn-secondary">Cancel</button>
          <button id="btn-engine-apply" class="btn btn-primary"
            ${isCloud() && (!consented || !keyReady) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
            Use this engine
          </button>
        </div>
      </div>
    `;

    attach();
  }

  function close() {
    modal.remove();
    if (onClose) onClose();
  }

  function attach() {
    modal.querySelector('.btn-close-modal').addEventListener('click', close);
    modal.querySelector('#btn-engine-cancel').addEventListener('click', close);
    modal.querySelector('#btn-manage-local-model')?.addEventListener('click', () => {
      modal.remove();
      onOpenModelHub();
    });

    modal.querySelectorAll('input[name="engine"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        selectedEngine = e.target.value;
        validationMessage = '';
        validationOk = null;
        render();
      });
    });
    // The whole card is a click target, but clicking the radio inside it must not
    // then toggle twice.
    modal.querySelectorAll('.engine-option').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        selectedEngine = card.dataset.engine;
        validationMessage = '';
        validationOk = null;
        render();
      });
    });

    const consentBox = modal.querySelector('#cloud-consent');
    if (consentBox) {
      consentBox.addEventListener('change', (e) => {
        consented = e.target.checked;
        if (consented) {
          grantCloudConsent();
        } else {
          revokeCloudConsent();
          if (audioManager.engineId === ENGINE_IDS.OPENAI) {
            audioManager.setEngine(ENGINE_IDS.KOKORO);
            selectedEngine = ENGINE_IDS.KOKORO;
            if (onEngineChanged) onEngineChanged(ENGINE_IDS.KOKORO);
          }
        }
        render();
      });
    }

    const keyInput = modal.querySelector('#openai-key-input');
    if (keyInput) {
      keyInput.addEventListener('input', (e) => {
        saveOpenAIKey(e.target.value);
        validationMessage = '';
        validationOk = null;
        const apply = modal.querySelector('#btn-engine-apply');
        if (apply) {
          const ready = consented && e.target.value.trim().length > 0;
          apply.disabled = !ready;
          apply.style.opacity = ready ? '' : '0.5';
          apply.style.cursor = ready ? '' : 'not-allowed';
        }
      });
    }

    const reveal = modal.querySelector('#btn-reveal-key');
    if (reveal && keyInput) {
      reveal.addEventListener('click', () => {
        keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      });
    }

    const test = modal.querySelector('#btn-test-key');
    if (test) {
      test.addEventListener('click', async () => {
        validating = true;
        validationMessage = '';
        render();
        const result = await validateOpenAIKey(loadOpenAIKey());
        validating = false;
        validationOk = result.ok;
        validationMessage = result.ok
          ? 'Key works — gpt-4o-mini-tts is reachable.'
          : describeValidationReason(result.reason);
        render();
      });
    }

    const forget = modal.querySelector('#btn-forget-key');
    if (forget) {
      forget.addEventListener('click', () => {
        clearOpenAIKey();
        validationMessage = '';
        validationOk = null;
        render();
      });
    }

    modal.querySelector('#btn-engine-apply').addEventListener('click', () => {
      if (selectedEngine !== audioManager.engineId) {
        audioManager.setEngine(selectedEngine);
        if (onEngineChanged) onEngineChanged(selectedEngine);
      }
      close();
    });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  render();
  return modal;
}

import { getIconSvg } from '../utils/icons.js';
import { escapeHtml } from '../utils/escape-html.js';
import { ENGINE_IDS } from '../audio/engine-contract.js';
import { CHATTERBOX_DOWNLOAD_BYTES, clearChatterboxCache } from '../audio/chatterbox-engine.js';
import { ModelCacheManager } from '../audio/model-cache-manager.js';
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

// What each install stage is actually doing, in the user's terms. Only this line
// carries aria-live: the percentage next to it changes several times a second,
// which would make a screen reader unusable.
const STAGE_COPY = {
  probe: 'Checking what is already on this device',
  download: 'Downloading — you can close this window, the install keeps going',
  building: 'Building the speech models',
  done: 'Ready'
};

const MAX_MESSAGE_CHARS = 300;

function short(text) {
  const value = typeof text === 'string' ? text : '';
  return value.length > MAX_MESSAGE_CHARS ? `${value.slice(0, MAX_MESSAGE_CHARS)}…` : value;
}

export function createEngineSettingsModal({ audioManager, onClose, onEngineChanged, onOpenModelHub }) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  let selectedEngine = audioManager.engineId;
  let consented = hasCloudConsent();
  let validating = false;
  let validationMessage = '';
  let validationOk = null;
  let studioStatus = { installed: false, partial: false, storable: true, persisted: false, fileCount: 0 };
  let studioStatusReady = false;
  let installingStudio = false;
  let studioProgress = 0;
  let studioMessage = '';
  let studioStage = 'probe';
  let unsubscribeStudioProgress = null;
  let closed = false;

  // Live references to the three nodes that change during an install, so
  // progress can be patched in place. Rebuilding the modal per progress event —
  // which is what this used to do — put a full innerHTML parse and a dozen
  // listener rebinds between every network chunk and the next, on the same
  // thread as the bar it was trying to animate. See the same note in main.js.
  let studioRefs = null;
  let studioFrame = 0;

  const isCloud = () => selectedEngine === ENGINE_IDS.OPENAI;
  const isStudio = () => selectedEngine === ENGINE_IDS.CHATTERBOX;
  // Straight off the class rather than through `audioManager.modelCacheManager`:
  // formatting a byte count needs no manager instance, and reaching for one at
  // construction time would make this modal unrenderable without a full manager.
  const formatBytes = (bytes) => ModelCacheManager.formatBytes(bytes);
  const downloadSize = formatBytes(CHATTERBOX_DOWNLOAD_BYTES);

  function studioChipLabel() {
    if (!studioStatusReady) return 'Checking…';
    if (studioStatus.installed) return 'Installed';
    if (studioStatus.partial) return 'Partly downloaded';
    return `${downloadSize} download`;
  }

  function applyLabel() {
    if (installingStudio) return 'Installing…';
    if (!isStudio()) return 'Use this engine';
    if (!studioStatusReady) return 'Checking…';
    return studioStatus.installed ? 'Use this engine' : 'Install Studio Local';
  }

  function render() {
    // A structural render after the modal has closed would rebuild a detached
    // tree, and the install continues past the modal's lifetime by design.
    if (closed) return;

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

          <label class="engine-option ${isStudio() ? 'selected' : ''}" data-engine="${ENGINE_IDS.CHATTERBOX}" style="
            display: block; padding: 14px; border-radius: 10px; cursor: pointer;
            border: 1px solid ${isStudio() ? 'var(--brass)' : 'var(--border)'};
            background: ${isStudio() ? 'var(--brass-soft)' : 'transparent'};">
            <div style="display: flex; align-items: center; gap: 10px;">
              <input type="radio" name="engine" value="${ENGINE_IDS.CHATTERBOX}"
                ${isStudio() ? 'checked' : ''} style="accent-color: var(--brass);">
              <span style="font-weight: 700; color: var(--text-primary);">Studio Local</span>
              <span class="badge-voice">Chatterbox · Highest local quality</span>
              <span class="engine-install-state ${studioStatus.installed ? 'is-installed' : ''}">
                ${studioChipLabel()}
              </span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px; line-height: 1.5;">
              More natural, expressive character performances using private 5–10 second
              reference recordings. Runs entirely on this device after a one-time model download.
              Best on a desktop browser with WebGPU.
            </div>
          </label>

          ${isStudio() ? `
            <div class="studio-install-panel">
              <div>
                <strong>${studioStatus.installed ? 'Available offline' : 'Install only when you choose'}</strong>
                <span>${studioInstallBlurb()}</span>
              </div>
              <div class="studio-install-progress" ${installingStudio ? '' : 'hidden'}>
                <div class="studio-install-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"
                     aria-valuenow="0" aria-label="Studio Local install progress"><span class="studio-install-fill"></span></div>
                <small class="studio-install-text"></small>
                <small class="studio-install-stage" aria-live="polite"></small>
              </div>
              <p>Use only recordings you own or have permission to clone.</p>
              ${studioStatus.fileCount > 0 && !installingStudio ? `
                <button id="btn-studio-remove" class="btn btn-secondary" type="button"
                        style="align-self:flex-start; font-size: 0.72rem; padding: 5px 10px;">
                  Remove Studio Local
                </button>
              ` : ''}
            </div>
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

          ${validationMessage && !isCloud() ? `
            <div class="engine-settings-message ${validationOk ? 'is-success' : 'is-error'}" role="alert">
              ${escapeHtml(validationMessage)}
            </div>
          ` : ''}
        </div>

        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="btn-engine-cancel" class="btn btn-secondary">
            ${installingStudio ? 'Cancel install' : 'Cancel'}
          </button>
          <button id="btn-engine-apply" class="btn btn-primary"
            ${(isCloud() && (!consented || !keyReady)) || installingStudio || (isStudio() && !studioStatusReady) ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
            ${applyLabel()}
          </button>
        </div>
      </div>
    `;

    attach();
  }

  function studioInstallBlurb() {
    if (!studioStatus.storable) {
      return 'This browser cannot store a model this large, so Studio Local will download again '
        + 'each session. Kokoro is the better local choice here.';
    }
    if (studioStatus.installed) {
      return studioStatus.persisted
        ? 'Persistent browser storage granted.'
        : 'Saved on this device; the browser may evict it under storage pressure.';
    }
    if (studioStatus.partial) {
      return `Part of the model is already downloaded. Installing resumes from where it stopped.`;
    }
    return `About ${downloadSize}. The screenplay and voice references never leave this device.`;
  }

  function close() {
    closed = true;
    // Deliberately does not cancel a running install — the global progress toast
    // picks it up, which is why the stage copy invites closing this window.
    if (unsubscribeStudioProgress) unsubscribeStudioProgress();
    unsubscribeStudioProgress = null;
    if (studioFrame) studioFrame = 0;
    modal.remove();
    if (onClose) onClose();
  }

  function captureStudioRefs() {
    const panel = modal.querySelector('.studio-install-progress');
    studioRefs = panel
      ? {
        panel,
        bar: panel.querySelector('.studio-install-bar'),
        fill: panel.querySelector('.studio-install-fill'),
        text: panel.querySelector('.studio-install-text'),
        stage: panel.querySelector('.studio-install-stage')
      }
      : null;
    // Seed straight away so a structural render mid-install does not blank the
    // readout until the next progress event arrives.
    paintStudioProgress();
  }

  function paintStudioProgress() {
    if (!studioRefs) return;
    const pct = Math.max(0, Math.min(100, Math.round(studioProgress)));
    studioRefs.panel.hidden = !installingStudio;
    studioRefs.fill.style.width = `${Math.max(2, pct)}%`;
    studioRefs.bar.setAttribute('aria-valuenow', String(pct));
    // textContent, not innerHTML — these strings carry engine and error text, so
    // this closes the injection surface rather than escaping around it.
    studioRefs.text.textContent = studioMessage || 'Preparing…';
    studioRefs.stage.textContent = STAGE_COPY[studioStage] || '';
  }

  function scheduleStudioPaint() {
    if (studioFrame) return;
    // An animation frame aligns the write with a paint and costs nothing while
    // the tab is hidden — but it also never *fires* while the tab is hidden, and
    // a multi-gigabyte install is precisely the thing people leave running in a
    // background tab. Left on rAF alone, the first suppressed frame would latch
    // and every later update would be dropped until the tab came back.
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const schedule = !hidden && typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    studioFrame = schedule(() => {
      studioFrame = 0;
      paintStudioProgress();
    }) || 1;
  }

  function attach() {
    modal.querySelector('.btn-close-modal').addEventListener('click', close);

    modal.querySelector('#btn-engine-cancel').addEventListener('click', () => {
      if (installingStudio) {
        // Cancel has to mean cancel: without this it only closed the modal and
        // left a worker pulling well over a gigabyte with nothing referencing it.
        audioManager.getEngine(ENGINE_IDS.CHATTERBOX)?.abortInit?.();
        return;
      }
      close();
    });

    modal.querySelector('#btn-manage-local-model')?.addEventListener('click', () => {
      modal.remove();
      onOpenModelHub();
    });

    modal.querySelectorAll('input[name="engine"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        if (installingStudio) return;
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
        if (e.target.tagName === 'INPUT' || installingStudio) return;
        selectedEngine = card.dataset.engine;
        validationMessage = '';
        validationOk = null;
        render();
      });
    });

    const removeStudio = modal.querySelector('#btn-studio-remove');
    if (removeStudio) {
      removeStudio.addEventListener('click', async () => {
        if (installingStudio) return;
        const held = studioStatus.cachedBytes ? formatBytes(studioStatus.cachedBytes) : downloadSize;
        if (!confirm(`Remove the Studio Local model from this device? That frees about ${held}, and it will have to download again.`)) {
          return;
        }
        removeStudio.disabled = true;
        removeStudio.textContent = 'Removing…';
        audioManager.getEngine(ENGINE_IDS.CHATTERBOX)?.release?.();
        await clearChatterboxCache();
        studioStatus = await audioManager.getChatterboxCacheStatus();
        render();
      });
    }

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

    modal.querySelector('#btn-engine-apply').addEventListener('click', onApply);

    captureStudioRefs();
  }

  async function onApply() {
    if (isStudio() && !(await installStudio())) return;

    if (selectedEngine !== audioManager.engineId) {
      audioManager.setEngine(selectedEngine);
      if (onEngineChanged) onEngineChanged(selectedEngine);
    }
    close();
  }

  /** @returns {Promise<boolean>} whether the engine is ready to be switched to. */
  async function installStudio() {
    // Refuse rather than start something that cannot finish. Without OPFS the
    // worker hands the whole 1.4 GB to transformers.js, whose `readResponse`
    // reallocates and copies its entire buffer per chunk when Hugging Face sends
    // no Content-Length — enough to get the worker killed for memory, a death
    // that fires no error event. The user would then watch a frozen bar until
    // the engine's three-minute deadline timer gave up. `storable` is false
    // exactly when the OPFS cache could not be created.
    if (!studioStatus.storable) {
      validationMessage = 'This browser cannot store a model this large, and Studio Local '
        + 'is too big to load without storing it. Kokoro runs locally here instead.';
      validationOk = false;
      render();
      return false;
    }

    const estimate = await audioManager.modelCacheManager.getStorageEstimate();
    const available = Math.max(0, estimate.quota - estimate.usage);
    const needed = CHATTERBOX_DOWNLOAD_BYTES * 1.1;
    if (!studioStatus.installed && estimate.quota > 0 && available < needed) {
      validationMessage = `Studio Local needs about ${formatBytes(needed)} free in browser storage; `
        + `this browser reports ${formatBytes(available)} available.`;
      validationOk = false;
      render();
      return false;
    }

    installingStudio = true;
    studioProgress = 2;
    studioStage = 'probe';
    studioMessage = studioStatus.installed ? 'Loading the installed model…' : 'Preparing the one-time download…';
    validationMessage = '';

    const studioEngine = audioManager.getEngine(ENGINE_IDS.CHATTERBOX);
    // A load may already be in flight — the app warms an installed model at boot,
    // and `init()` hands back the running promise rather than starting a second
    // one. Adopt the engine's real position instead of showing a made-up 2% until
    // the next event happens to arrive.
    if (studioEngine.isLoading && Number.isFinite(studioEngine.loadProgress)) {
      studioProgress = studioEngine.loadProgress;
      studioMessage = studioEngine.statusMessage || studioMessage;
      studioStage = studioEngine.stage || studioStage;
    }
    unsubscribeStudioProgress = studioEngine.onProgress(payload => {
      // Number.isFinite, not a truthiness check: the error and cancel paths both
      // report 0, which a falsy test silently discards.
      if (Number.isFinite(payload.progress)) studioProgress = payload.progress;
      if (payload.message) studioMessage = payload.message;
      if (payload.stage) studioStage = payload.stage;
      scheduleStudioPaint();
    });
    render();

    try {
      await audioManager.prepareEngine(ENGINE_IDS.CHATTERBOX);
      studioStatus = await audioManager.getChatterboxCacheStatus();
      studioStatusReady = true;
      installingStudio = false;
      // Confirm the action before the modal disappears; previously it just closed.
      const apply = modal.querySelector('#btn-engine-apply');
      if (apply) apply.textContent = 'Installed';
      return true;
    } catch (error) {
      installingStudio = false;
      // Re-probe first, so the panel describes what actually landed rather than
      // the state from before the attempt.
      studioStatus = await audioManager.getChatterboxCacheStatus().catch(() => studioStatus);
      if (!error?.cancelled) {
        // Always keep a subject. This banner is a `role="alert"`, and what
        // arrives here can be a raw browser binding error — the Safari install
        // bug reached users as the four words "Not enough arguments" and nothing
        // else. The detail is worth keeping; it just cannot stand alone.
        const detail = short(error?.message);
        validationMessage = detail
          ? short(`Studio Local could not be installed: ${detail}`)
          : 'Studio Local could not be installed.';
        validationOk = false;
      }
      render();
      return false;
    } finally {
      if (unsubscribeStudioProgress) unsubscribeStudioProgress();
      unsubscribeStudioProgress = null;
    }
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  render();
  const readStudioStatus = audioManager.getChatterboxCacheStatus
    ? audioManager.getChatterboxCacheStatus()
    : Promise.resolve({ installed: false, partial: false, storable: true, persisted: false, fileCount: 0 });
  readStudioStatus.then(status => {
    studioStatus = status;
    studioStatusReady = true;
    render();
  }).catch(() => {
    studioStatusReady = true;
    render();
  });
  return modal;
}

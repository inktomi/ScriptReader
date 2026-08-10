import './index.css';
import { ScriptStore } from './screenplay/script-store.js';
import { ScreenplayAudioManager, ENGINE_TYPES, PLAYBACK_STATES } from './audio/audio-manager.js';
import { AudioVisualizer } from './audio/audio-visualizer.js';
import { createHeader } from './ui/header.js';
import { createCastPanel } from './ui/cast-panel.js';
import { createScriptTeleprompter } from './ui/script-teleprompter.js';
import { createTransportBar } from './ui/transport-bar.js';
import { createSceneDrawer } from './ui/scene-drawer.js';
import { createUploadModal } from './ui/upload-modal.js';
import { createHelpModal } from './ui/help-modal.js';
import { createHfModelHubModal } from './ui/hf-model-hub.js';
import { createVoiceConfigModal } from './ui/voice-config-modal.js';

// Application Orchestrator
async function initApp() {
  const appRoot = document.getElementById('app');

  const scriptStore = new ScriptStore();
  const audioManager = new ScreenplayAudioManager();
  await audioManager.init();

  let activeVoiceModal = null;

  function openVoiceConfigModal(isInitialSetup = false) {
    if (activeVoiceModal) {
      activeVoiceModal.remove();
      activeVoiceModal = null;
    }

    activeVoiceModal = createVoiceConfigModal({
      scriptStore,
      audioManager,
      isInitialSetup,
      onSave: ({ narratorVoiceId, castAssignments }) => {
        audioManager.setScript(
          scriptStore.currentScript.elements,
          scriptStore.castAssignments,
          scriptStore.activeLineIndex
        );
        audioManager.setNarratorVoice(narratorVoiceId);
        castPanel.render();
        teleprompter.renderScript();
        transportBar.updateProgress(scriptStore.activeLineIndex, scriptStore.currentScript.elements.length);
        
        const activeElem = scriptStore.currentScript.elements[scriptStore.activeLineIndex];
        if (activeElem) {
          transportBar.updateActiveSpeaker(
            activeElem,
            audioManager.getVoiceProfileForCharacter(activeElem.character),
            activeElem.nuance
          );
        }
        
        showResumeToast(`✨ Voice setup saved for "${scriptStore.currentScript.title}"!`);
        activeVoiceModal = null;
      },
      onCancel: () => {
        activeVoiceModal = null;
      }
    });

    document.body.appendChild(activeVoiceModal);
  }

  // 1. Create Core UI Components
  const header = createHeader({
    onLoadSample: (sampleId) => {
      audioManager.stop();
      scriptStore.loadSample(sampleId, false);
      audioManager.setScript(
        scriptStore.currentScript.elements,
        scriptStore.castAssignments,
        scriptStore.activeLineIndex
      );
      audioManager.setNarratorVoice(scriptStore.narratorVoiceId);
      teleprompter.renderScript();
      castPanel.render();
      sceneDrawer.render();
      transportBar.updateProgress(scriptStore.activeLineIndex, scriptStore.currentScript.elements.length);
      
      const activeElem = scriptStore.currentScript.elements[scriptStore.activeLineIndex];
      if (activeElem) {
        transportBar.updateActiveSpeaker(
          activeElem,
          audioManager.getVoiceProfileForCharacter(activeElem.character),
          activeElem.nuance
        );
      }
    },
    onOpenUpload: () => openUploadModal(),
    onOpenHfHub: () => openHfHubModal(),
    onOpenVoiceConfig: () => openVoiceConfigModal(false),
    onToggleCast: () => {
      const isOpen = castPanel.toggleCollapse();
      const btn = header.element.querySelector('#btn-toggle-cast');
      if (btn) btn.classList.toggle('btn-active', isOpen);
    },
    onToggleScenes: () => {
      const isOpen = sceneDrawer.toggle();
      const btn = header.element.querySelector('#btn-toggle-scenes');
      if (btn) btn.classList.toggle('btn-active', isOpen);
    },
    onToggleHelp: () => openHelpModal(),
    currentEngine: ENGINE_TYPES.KOKORO_NEURAL
  });

  const castPanel = createCastPanel({
    scriptStore,
    audioManager,
    onOpenVoiceConfig: () => openVoiceConfigModal(false)
  });

  const teleprompter = createScriptTeleprompter({
    scriptStore,
    audioManager,
    onLineClick: (lineIndex) => {
      audioManager.seek(lineIndex);
      scriptStore.setActiveLine(lineIndex);
    }
  });

  const sceneDrawer = createSceneDrawer({
    scriptStore,
    onSelectScene: (lineIndex) => {
      audioManager.seek(lineIndex);
      scriptStore.setActiveLine(lineIndex);
    },
    onClose: () => {
      const btn = header.element.querySelector('#btn-toggle-scenes');
      if (btn) btn.classList.remove('btn-active');
    }
  });

  const transportBar = createTransportBar({
    audioManager,
    scriptStore,
    onPlay: () => audioManager.play(),
    onPause: () => audioManager.pause(),
    onStop: () => {
      audioManager.stop();
      audioManager.seek(0);
      scriptStore.setActiveLine(0);
      teleprompter.highlightActiveLine(0, true);
      transportBar.updatePlaybackState(PLAYBACK_STATES.IDLE);
      transportBar.updateProgress(0, scriptStore.currentScript ? scriptStore.currentScript.elements.length : 0);
    },
    onSkipNext: () => audioManager.skipNext(),
    onSkipPrev: () => audioManager.skipPrev(),
    onSeek: (index) => {
      audioManager.seek(index);
      scriptStore.setActiveLine(index);
    }
  });

  // Assemble App Layout
  const appBody = document.createElement('div');
  appBody.className = 'app-body';
  appBody.appendChild(castPanel.element);
  appBody.appendChild(teleprompter.element);
  appBody.appendChild(sceneDrawer.element);

  appRoot.appendChild(header.element);
  appRoot.appendChild(appBody);
  appRoot.appendChild(transportBar.element);

  // Dev-only handle for inspecting playback timing from the console.
  if (import.meta.env && import.meta.env.DEV) {
    window.__scriptReader = { audioManager, scriptStore };
  }

  // `?debug=parse` prints how the script was understood — who overlaps whom,
  // where the pace changes, and what each line will actually be asked to say.
  // Reading that table is far quicker than listening for a parse mistake.
  if (new URLSearchParams(window.location.search).get('debug') === 'parse') {
    const dumpParse = () => {
      const script = scriptStore.currentScript;
      if (!script) return;
      console.log(`%cParse: ${script.title}`, 'font-weight:bold');
      console.table(script.elements.map((e, i) => ({
        i,
        type: e.type,
        character: e.character,
        pace: e.pace,
        linePace: e.linePace || '',
        overlap: (e.overlap && e.overlap.mode) || '',
        via: (e.overlap && e.overlap.source) || '',
        cutOff: !!e.cutOff,
        pan: audioManager.getPanForCharacter(e.character).toFixed(2),
        spoken: (e.nuance && e.nuance.cleanSpeech) || ''
      })));
    };
    scriptStore.subscribe(event => {
      if (event === 'scriptLoaded') dumpParse();
    });
    window.__dumpParse = dumpParse;
  }

  // Initialize Canvas Visualizer
  const visualizer = new AudioVisualizer(transportBar.visualizerCanvas);
  audioManager.setVisualizer(visualizer);
  visualizer.start();

  // Connect Audio Events to UI State
  audioManager.subscribe((event, data) => {
    switch (event) {
      case 'stateChange':
        transportBar.updatePlaybackState(data.state);
        break;

      case 'lineStart':
        // The store notifies the teleprompter with a single index, which would
        // clear the other speaker in an overlap. Set it first, then paint the
        // full set over the top.
        scriptStore.setActiveLine(data.index);
        teleprompter.setActiveLines(audioManager.getActiveLineIndices(), data.isClusterHead);
        transportBar.updateActiveSpeaker(
          data.element, data.voice, data.nuance,
          data.concurrent.map(i => scriptStore.currentScript.elements[i])
        );
        transportBar.updateProgress(data.index, scriptStore.currentScript.elements.length);
        castPanel.setSpeakingCharacters(audioManager.getActiveCharacters());
        break;

      case 'lineEnd':
        // One voice stopping does not mean the room went quiet.
        teleprompter.setActiveLines(audioManager.getActiveLineIndices(), false);
        castPanel.setSpeakingCharacters(audioManager.getActiveCharacters());
        break;

      // Emitted by seek() while stopped or paused — keep the transport readout
      // in step with the jump even though no audio started.
      case 'lineChange':
        if (data.element) {
          transportBar.updateProgress(data.index, scriptStore.currentScript.elements.length);
          transportBar.updateActiveSpeaker(
            data.element,
            audioManager.getVoiceProfileForCharacter(data.element.character),
            data.element.nuance
          );
        }
        break;

      case 'complete':
        transportBar.updatePlaybackState(PLAYBACK_STATES.IDLE);
        transportBar.updateActiveSpeaker(null, null, null);
        break;
    }
  });

  // Modal Handlers
  function openUploadModal() {
    const modal = createUploadModal({
      onPdfSelected: async (file, onProgress) => {
        audioManager.stop();
        await scriptStore.loadPdf(file, onProgress);
        audioManager.setScript(scriptStore.currentScript.elements, scriptStore.castAssignments, 0);
        audioManager.setNarratorVoice(scriptStore.narratorVoiceId);
        teleprompter.renderScript();
        castPanel.render();
        sceneDrawer.render();
        transportBar.updateProgress(0, scriptStore.currentScript.elements.length);
        
        // Present voice configuration for freshly uploaded script
        openVoiceConfigModal(true);
      },
      onFountainTextSubmitted: (text, title) => {
        audioManager.stop();
        scriptStore.loadFountainText(text, title, true);
        audioManager.setScript(scriptStore.currentScript.elements, scriptStore.castAssignments, 0);
        audioManager.setNarratorVoice(scriptStore.narratorVoiceId);
        teleprompter.renderScript();
        castPanel.render();
        sceneDrawer.render();
        transportBar.updateProgress(0, scriptStore.currentScript.elements.length);

        // Present voice configuration for freshly loaded script
        openVoiceConfigModal(true);
      }
    });
    document.body.appendChild(modal);
  }

  function openHfHubModal() {
    const modal = createHfModelHubModal({
      currentModelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      onSelectModel: async (modelId) => {
        if (!audioManager.kokoroEngine.isReady && !audioManager.kokoroEngine.isLoading) {
          // The progress subscriber owns the toast for every phase, failure
          // included. Driving it from here too would dismiss the error state
          // three seconds later and take the Retry button with it.
          audioManager.kokoroEngine.init().catch(() => {});
        }
      }
    });
    document.body.appendChild(modal);
  }

  function openHelpModal() {
    const modal = createHelpModal({});
    document.body.appendChild(modal);
  }

  // Toast Notification
  function showResumeToast(msg) {
    const existing = document.getElementById('app-resume-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'app-resume-toast';
    toast.className = 'resume-toast-pill';
    toast.innerHTML = `
      <span>🎬</span>
      <span>${msg}</span>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.classList.add('toast-fadeout');
        setTimeout(() => toast.remove(), 300);
      }
    }, 4000);
  }

  // Connect Kokoro Engine Progress to UI Toast and Header Badge.
  //
  // Deliberately synchronous. This fires once per network chunk — thousands of
  // times while the multi-hundred-MB weights stream — so anything awaited here
  // piles up on the main thread and freezes the very bar it is trying to update.
  // A cache-status sweep is especially costly (two caches.open + keys + a match
  // per entry), so the badge is refreshed on phase transitions instead.
  audioManager.kokoroEngine.onProgress(({ progress, message, phase, isCachedLocally }) => {
    if (phase === 'error') {
      showNeuralErrorNotification(message);
      refreshEngineCacheBadge();
      return;
    }

    if (phase === 'ready') {
      // The engine's own message already distinguishes "cached locally" from
      // "ready but the weights did not fit in Cache Storage" — don't second-guess
      // it here, both of the old strings claimed a cache that may not exist.
      removeNeuralLoadingNotification(message);
      refreshEngineCacheBadge();
      // Render the opening lines now so the first Play starts instantly.
      audioManager.prewarm();
      return;
    }

    if (!neuralToast) {
      showNeuralLoadingNotification();
    }
    const msg = neuralToast ? neuralToast.querySelector('#neural-toast-msg') : null;
    const pct = neuralToast ? neuralToast.querySelector('#neural-toast-pct') : null;
    const fill = neuralToast ? neuralToast.querySelector('#neural-toast-fill') : null;
    if (msg) msg.textContent = message;
    if (pct) pct.textContent = `${progress}%`;
    if (fill) fill.style.width = `${progress}%`;
  });

  function refreshEngineCacheBadge() {
    audioManager.getCacheStatus()
      .then(status => header.updateEngineCacheBadge(status))
      .catch(err => console.warn('Cache status notice:', err));
  }

  // Initial check of local cache status
  refreshEngineCacheBadge();

  // Neural Loading Notification Toast
  let neuralToast = null;
  function showNeuralLoadingNotification() {
    if (neuralToast) neuralToast.remove();
    neuralToast = document.createElement('div');
    neuralToast.className = 'neural-progress-container';
    neuralToast.style.position = 'fixed';
    neuralToast.style.top = '84px';
    neuralToast.style.right = '24px';
    neuralToast.style.zIndex = '90';
    neuralToast.style.minWidth = '320px';
    neuralToast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.6)';
    neuralToast.innerHTML = `
      <div style="display: flex; justify-content: space-between; font-size: 0.8rem; font-weight: 600; color: #06B6D4;">
        <span id="neural-toast-msg">Loading Kokoro-82M Neural Engine...</span>
        <span id="neural-toast-pct">15%</span>
      </div>
      <div class="neural-progress-bar">
        <div class="neural-progress-fill" id="neural-toast-fill" style="width: 15%;"></div>
      </div>
    `;
    document.body.appendChild(neuralToast);
  }

  function dismissNeuralToast() {
    if (neuralToast) {
      neuralToast.remove();
      neuralToast = null;
    }
  }

  /**
   * Replace the progress toast with a failure state.
   *
   * Without this the toast keeps whatever text it had when the engine died —
   * which on a fresh visit is the "Downloading model weights..." line, making a
   * hard failure look identical to a slow download that never ends.
   */
  function showNeuralErrorNotification(message) {
    if (!neuralToast) showNeuralLoadingNotification();
    if (!neuralToast) return;

    neuralToast.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 0.8rem; font-weight: 600; color: #F87171;">
        <span>Neural voice engine unavailable</span>
        <button id="neural-toast-dismiss" title="Dismiss" style="background: none; border: none; color: #F87171; cursor: pointer; font-size: 1rem; line-height: 1; padding: 0;">&times;</button>
      </div>
      <div id="neural-toast-error" style="margin-top: 6px; font-size: 0.72rem; color: #FCA5A5; line-height: 1.45; word-break: break-word;"></div>
      <button id="neural-toast-retry" style="margin-top: 10px; padding: 5px 12px; font-size: 0.72rem; font-weight: 600; color: #06B6D4; background: rgba(6, 182, 212, 0.12); border: 1px solid rgba(6, 182, 212, 0.4); border-radius: 6px; cursor: pointer;">Retry</button>
    `;

    // textContent, not innerHTML — this string is an arbitrary Error message.
    const detail = neuralToast.querySelector('#neural-toast-error');
    if (detail) detail.textContent = message;

    const dismiss = neuralToast.querySelector('#neural-toast-dismiss');
    if (dismiss) dismiss.addEventListener('click', dismissNeuralToast);

    const retry = neuralToast.querySelector('#neural-toast-retry');
    if (retry) {
      retry.addEventListener('click', () => {
        // Drop the toast entirely so the next 'loading' event rebuilds it with
        // the progress markup rather than patching the error markup.
        dismissNeuralToast();
        audioManager.kokoroEngine.init().catch(() => {
          /* the error phase re-renders the toast; nothing to do here */
        });
      });
    }
  }

  function removeNeuralLoadingNotification(finalMsg) {
    if (neuralToast) {
      const msg = neuralToast.querySelector('#neural-toast-msg');
      const pct = neuralToast.querySelector('#neural-toast-pct');
      const fill = neuralToast.querySelector('#neural-toast-fill');
      if (msg) msg.textContent = finalMsg;
      // The bar is capped at 99% during load; leaving it there made a finished
      // engine read as still-loading for the three seconds before it fades.
      if (pct) pct.textContent = '100%';
      if (fill) fill.style.width = '100%';
      setTimeout(dismissNeuralToast, 3000);
    }
  }

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    const isTextInput = target && (
      target.tagName === 'TEXTAREA' ||
      (target.tagName === 'INPUT' && ['text', 'search', 'password', 'email', 'number'].includes(target.type)) ||
      target.isContentEditable
    );
    if (isTextInput) return;

    if (e.code === 'Space' || e.key === ' ' || e.keyCode === 32) {
      e.preventDefault();
      e.stopPropagation();
      if (audioManager.playbackState === PLAYBACK_STATES.PLAYING ||
          audioManager.playbackState === PLAYBACK_STATES.BUFFERING) {
        audioManager.pause();
      } else {
        audioManager.play();
      }
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      audioManager.skipPrev();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      audioManager.skipNext();
    } else if (e.key === 'c' || e.key === 'C') {
      const isOpen = castPanel.toggleCollapse();
      const btn = header.element.querySelector('#btn-toggle-cast');
      if (btn) btn.classList.toggle('btn-active', isOpen);
    } else if (e.key === 'v' || e.key === 'V') {
      openVoiceConfigModal(false);
    } else if (e.key === 's' || e.key === 'S') {
      const isOpen = sceneDrawer.toggle();
      const btn = header.element.querySelector('#btn-toggle-scenes');
      if (btn) btn.classList.toggle('btn-active', isOpen);
    } else if (e.key === '?') {
      openHelpModal();
    }
  });

  window.addEventListener('beforeunload', () => {
    scriptStore.saveCurrentState();
  });

  // Restore previous session from LocalStorage or load default sample
  const wasRestored = scriptStore.restoreSavedSession();

  if (wasRestored) {
    const activeLine = scriptStore.activeLineIndex;
    audioManager.setScript(
      scriptStore.currentScript.elements,
      scriptStore.castAssignments,
      activeLine
    );
    audioManager.setNarratorVoice(scriptStore.narratorVoiceId);

    if (scriptStore.sampleId) {
      header.setSelectedSample(scriptStore.sampleId);
    }

    teleprompter.renderScript();
    teleprompter.highlightActiveLine(activeLine, true);
    castPanel.render();
    sceneDrawer.render();
    transportBar.updateProgress(activeLine, scriptStore.currentScript.elements.length);

    const activeElem = scriptStore.currentScript.elements[activeLine];
    if (activeElem) {
      transportBar.updateActiveSpeaker(
        activeElem,
        audioManager.getVoiceProfileForCharacter(activeElem.character),
        activeElem.nuance
      );
    }

    if (activeLine > 0) {
      showResumeToast(`Resumed "${scriptStore.currentScript.title}" at line ${activeLine + 1}`);
    }
  } else {
    scriptStore.loadSample('neon-heist', false);
    header.setSelectedSample('neon-heist');
    audioManager.setScript(scriptStore.currentScript.elements, scriptStore.castAssignments, 0);
    audioManager.setNarratorVoice(scriptStore.narratorVoiceId);
    teleprompter.renderScript();
    castPanel.render();
    sceneDrawer.render();
    transportBar.updateProgress(0, scriptStore.currentScript.elements.length);
  }
}

// Start application
initApp().catch(err => console.error('App initialization error:', err));

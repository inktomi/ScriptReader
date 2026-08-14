import './index.css';
import { ScriptStore } from './screenplay/script-store.js';
import { ScreenplayAudioManager, ENGINE_TYPES, PLAYBACK_STATES } from './audio/audio-manager.js';
import { AudioVisualizer } from './audio/audio-visualizer.js';
import { createHeader } from './ui/header.js';
import { createCastPanel } from './ui/cast-panel.js';
import { createScriptTeleprompter } from './ui/script-teleprompter.js';
import { createTransportBar } from './ui/transport-bar.js';
import { createSceneDrawer } from './ui/scene-drawer.js';
import { createHelpModal } from './ui/help-modal.js';
import { createHfModelHubModal } from './ui/hf-model-hub.js';
import { createVoiceConfigModal } from './ui/voice-config-modal.js';
import { createEngineSettingsModal } from './ui/engine-settings-modal.js';
import { createResumeToastElement } from './ui/resume-toast.js';
import { createWelcomeScreen } from './ui/welcome-screen.js';
import { escapeHtml } from './utils/escape-html.js';
import { loadAppState, restoreCastBackup } from './utils/storage.js';
import { SAMPLE_SCRIPTS } from './screenplay/sample-scripts.js';
import { reconcileChatterboxVoiceStorage } from './audio/chatterbox-voice-store.js';

const APP_VIEWS = Object.freeze({
  WELCOME: 'WELCOME',
  CASTING: 'CASTING',
  PLAYER: 'PLAYER'
});

// Application Orchestrator
async function initApp() {
  const appRoot = document.getElementById('app');

  try {
    await reconcileChatterboxVoiceStorage();
  } catch (error) {
    console.warn('Studio voice library reconciliation notice:', error);
  }

  const scriptStore = new ScriptStore();
  const audioManager = new ScreenplayAudioManager();
  let currentView = APP_VIEWS.WELCOME;
  let audioReadyPromise = null;
  const ensureAudioReady = () => {
    if (!audioReadyPromise) audioReadyPromise = audioManager.init();
    return audioReadyPromise;
  };

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
      onOpenEngineSettings: () => openEngineSettingsModal(() => {
        if (isInitialSetup) openVoiceConfigModal(true);
      }),
      onSave: ({ narratorVoiceId, castAssignments }) => {
        audioManager.setNarratorVoice(narratorVoiceId);
        audioManager.setScript(
          scriptStore.currentScript.elements,
          scriptStore.castAssignments,
          scriptStore.activeLineIndex
        );
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
        
        header.setScript(scriptStore.currentScript);
        if (isInitialSetup) {
          showPlayer();
        } else {
          showResumeToast(`Voice cast saved for "${scriptStore.currentScript.title}".`);
        }
        activeVoiceModal = null;
      },
      onCancel: () => {
        activeVoiceModal = null;
        if (isInitialSetup) showWelcome();
      }
    });

    (isInitialSetup ? appRoot : document.body).appendChild(activeVoiceModal);
  }

  // 1. Create Core UI Components
  const header = createHeader({
    onChangeScript: () => showWelcome(),
    onOpenVoiceConfig: () => openVoiceConfigModal(false),
    onShowLibrary: tab => showLibraryTab(tab),
    onToggleHelp: () => openHelpModal(),
    onOpenEngineSettings: () => openEngineSettingsModal(),
    currentEngine: audioManager.engineId
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

  // Assemble the listening room. The rail contains one library at a time so the
  // screenplay, not dashboard chrome, owns the workspace.
  const libraryRail = document.createElement('aside');
  libraryRail.className = 'library-rail';
  libraryRail.innerHTML = `
    <div class="library-tabs" role="tablist" aria-label="Screenplay library">
      <button class="library-tab is-active" type="button" role="tab" data-library-tab="cast" aria-selected="true">Cast</button>
      <button class="library-tab" type="button" role="tab" data-library-tab="scenes" aria-selected="false">Scenes</button>
      <button class="btn-icon library-close" type="button" title="Close library" aria-label="Close library">×</button>
    </div>
  `;
  castPanel.element.classList.add('library-panel');
  sceneDrawer.element.classList.remove('collapsed');
  sceneDrawer.element.classList.add('library-panel');
  sceneDrawer.element.hidden = true;
  libraryRail.appendChild(castPanel.element);
  libraryRail.appendChild(sceneDrawer.element);

  function showLibraryTab(tab = 'cast') {
    if (currentView !== APP_VIEWS.PLAYER) return;
    const showScenes = tab === 'scenes';
    libraryRail.classList.remove('is-collapsed');
    castPanel.element.hidden = showScenes;
    sceneDrawer.element.hidden = !showScenes;
    libraryRail.querySelectorAll('.library-tab').forEach(button => {
      const active = button.dataset.libraryTab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }

  libraryRail.querySelectorAll('.library-tab').forEach(button => {
    button.addEventListener('click', () => showLibraryTab(button.dataset.libraryTab));
  });
  libraryRail.querySelector('.library-close').addEventListener('click', () => {
    libraryRail.classList.add('is-collapsed');
  });
  sceneDrawer.element.querySelector('.btn-close-scenes')?.addEventListener('click', () => {
    libraryRail.classList.add('is-collapsed');
  });

  // Assemble App Layout
  const appBody = document.createElement('div');
  appBody.className = 'app-body';
  appBody.appendChild(libraryRail);
  appBody.appendChild(teleprompter.element);

  const playerShell = document.createElement('section');
  playerShell.className = 'player-shell';
  playerShell.hidden = true;
  playerShell.appendChild(header.element);
  playerShell.appendChild(appBody);
  playerShell.appendChild(transportBar.element);
  appRoot.appendChild(playerShell);

  function syncLoadedScript() {
    if (!scriptStore.currentScript) return;
    const activeLine = scriptStore.activeLineIndex;
    audioManager.setNarratorVoice(scriptStore.getNarratorVoice(audioManager.engineId));
    audioManager.setScript(
      scriptStore.currentScript.elements,
      scriptStore.castAssignments,
      activeLine
    );
    header.setScript(scriptStore.currentScript);
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
  }

  function recentScriptSummary() {
    const saved = loadAppState();
    if (!saved || !saved.activeScriptKey) return null;
    const sample = saved.sampleId
      ? SAMPLE_SCRIPTS.find(item => item.id === saved.sampleId)
      : null;
    const title = sample?.title || saved.customScriptData?.title;
    if (!title) return null;
    return {
      title,
      detail: `${saved.scriptType === 'sample' ? 'Sample screenplay' : 'Imported screenplay'} · saved at line ${(saved.activeLineIndex || 0) + 1}`
    };
  }

  function showWelcome() {
    currentView = APP_VIEWS.WELCOME;
    audioManager.stop();
    scriptStore.saveCurrentState();
    activeVoiceModal?.remove();
    activeVoiceModal = null;
    playerShell.hidden = true;
    appRoot.querySelector('.welcome-screen')?.remove();

    const welcome = createWelcomeScreen({
      recentScript: recentScriptSummary(),
      onFileSelected: file => loadWelcomeFile(file, welcome),
      onPasteSubmitted: (text, title) => {
        scriptStore.loadFountainText(text, title, true);
        enterCasting();
      },
      onSelectSample: sampleId => {
        scriptStore.loadSample(sampleId, false);
        enterCasting();
      },
      onContinueRecent: () => {
        if (scriptStore.restoreSavedSession()) enterCasting();
      },
      onOpenHelp: () => openHelpModal()
    });
    appRoot.prepend(welcome);
  }

  async function loadWelcomeFile(file, welcome) {
    const name = file?.name || '';
    const extension = name.toLowerCase().split('.').pop();
    if (!['pdf', 'fountain', 'txt'].includes(extension)) {
      showActionToast('Choose a PDF, Fountain, or text screenplay.', 'Dismiss', () => {});
      return;
    }

    welcome.classList.add('is-loading');
    const dropTitle = welcome.querySelector('.dropzone-title');
    const dropCopy = welcome.querySelector('.dropzone-copy');
    if (dropTitle) dropTitle.textContent = 'Reading your screenplay…';
    if (dropCopy) dropCopy.textContent = name;

    try {
      if (extension === 'pdf') {
        await scriptStore.loadPdf(file, ({ page, totalPages }) => {
          if (dropCopy) dropCopy.textContent = `Extracting page ${page} of ${totalPages}`;
        });
      } else {
        const text = await file.text();
        scriptStore.loadFountainText(text, name.replace(/\.[^/.]+$/, ''), true);
      }
      enterCasting();
    } catch (err) {
      welcome.classList.remove('is-loading');
      if (dropTitle) dropTitle.textContent = 'We could not read that screenplay';
      if (dropCopy) dropCopy.textContent = err.message || 'Check the file and try again.';
    }
  }

  function enterCasting() {
    if (!scriptStore.currentScript) return;
    currentView = APP_VIEWS.CASTING;
    appRoot.querySelector('.welcome-screen')?.remove();
    playerShell.hidden = true;
    syncLoadedScript();
    ensureAudioReady().catch(() => {});
    openVoiceConfigModal(true);
  }

  function showPlayer() {
    if (!scriptStore.currentScript) return;
    currentView = APP_VIEWS.PLAYER;
    appRoot.querySelector('.welcome-screen')?.remove();
    activeVoiceModal?.remove();
    activeVoiceModal = null;
    syncLoadedScript();
    transportBar.updateRenderProgress(audioManager.renderStatus);
    playerShell.hidden = false;
  }

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

      case 'renderProgress':
        transportBar.updateRenderProgress(data);
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
          if (scriptStore.activeLineIndex !== data.index) {
            scriptStore.setActiveLine(data.index);
          }
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

      // A cloud engine that will not start is a problem the listener has to act
      // on — usually a missing, wrong, or unfunded key. Say so and open the place
      // where it gets fixed, rather than falling through to the browser's robotic
      // fallback voice and letting them conclude the engine sounds bad.
      case 'engineError':
        transportBar.updatePlaybackState(PLAYBACK_STATES.IDLE);
        // A supporting engine that will not load is a problem with one obvious
        // answer — read those lines with the engine that *did* load — so offer
        // that directly instead of sending the listener into settings to work
        // out which of two engines failed and which toggle un-splits the cast.
        if (data.action === 'disableHybridCasting') {
          showActionToast(data.message, 'Use one voice engine', () => {
            audioManager.setHybridCasting(false);
            audioManager.play();
          });
        } else {
          showActionToast(data.message, 'Settings', () => openEngineSettingsModal());
        }
        break;
    }
  });

  // Modal Handlers
  function openHfHubModal() {
    const modal = createHfModelHubModal({
      currentModelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      isModelBusy: () => audioManager.kokoroEngine.isLoading,
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

  // While the engine settings modal is open, its own inline install panel is the
  // contextual view; the global toast is what carries the install *after* the
  // modal closes, so the two must not both be on screen.
  let engineModalOpen = false;

  function openEngineSettingsModal(afterEngineChanged = null) {
    engineModalOpen = true;
    const modal = createEngineSettingsModal({
      audioManager,
      onClose: () => { engineModalOpen = false; },
      onOpenModelHub: () => {
        engineModalOpen = false;
        openHfHubModal();
      },
      onEngineChanged: (engineId) => {
        // The cast is per-engine, so switching re-resolves every character's
        // voice; re-pushing the assignments is what makes that visible.
        audioManager.setNarratorVoice(scriptStore.getNarratorVoice(engineId));
        audioManager.setScript(
          scriptStore.currentScript ? scriptStore.currentScript.elements : [],
          scriptStore.castAssignments,
          scriptStore.activeLineIndex
        );
        header.setEngineBadge(engineId);
        castPanel.render();
        showResumeToast(
          engineId === ENGINE_TYPES.OPENAI
            ? 'Cloud voices on — dialogue is sent to OpenAI to be spoken.'
            : (engineId === ENGINE_TYPES.CHATTERBOX
              ? 'Studio Local on — Chatterbox voices run privately on this device.'
              : (engineId === ENGINE_TYPES.RUNPOD
                ? 'RunPod GPU on — high-speed neural rendering on NVIDIA L40S.'
                : 'Local Kokoro voices on — nothing leaves this device.'))
        );
        if (afterEngineChanged) {
          afterEngineChanged(engineId);
        } else if (engineId === ENGINE_TYPES.CHATTERBOX) {
          // Chatterbox voices are private reference recordings rather than a
          // built-in catalog. Move straight into casting after installation so
          // the engine can never be selected with an unexplained empty cast.
          openVoiceConfigModal(false);
        }
      }
    });
    document.body.appendChild(modal);
  }

  // Toast Notification
  function showResumeToast(msg) {
    const existing = document.getElementById('app-resume-toast');
    if (existing) existing.remove();

    const toast = createResumeToastElement(msg);
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.classList.add('toast-fadeout');
        setTimeout(() => toast.remove(), 300);
      }
    }, 4000);
  }

  /**
   * A toast that offers to undo itself.
   *
   * Held four times longer than the plain one and never auto-dismissed while the
   * pointer is over it — an undo the reader never got a chance to click is the
   * same as no undo at all.
   */
  function showActionToast(msg, actionLabel, onAction) {
    const existing = document.getElementById('app-resume-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'app-resume-toast';
    toast.className = 'resume-toast-pill';
    toast.innerHTML = `
      <span>${escapeHtml(msg)}</span>
      <button id="toast-action-btn" class="btn btn-secondary" style="padding: 3px 10px; font-size: 0.72rem; margin-left: 6px;">
        ${escapeHtml(actionLabel)}
      </button>
    `;
    document.body.appendChild(toast);

    let dismissTimer = null;
    const dismiss = () => {
      if (!toast.parentNode) return;
      toast.classList.add('toast-fadeout');
      setTimeout(() => toast.remove(), 300);
    };
    const arm = () => { dismissTimer = setTimeout(dismiss, 16000); };

    toast.addEventListener('mouseenter', () => clearTimeout(dismissTimer));
    toast.addEventListener('mouseleave', arm);
    toast.querySelector('#toast-action-btn').addEventListener('click', () => {
      clearTimeout(dismissTimer);
      toast.remove();
      onAction();
    });
    arm();
  }

  /**
   * Tell the reader when a saved cast was lifted onto better voices, and let them
   * put it back. The change is worth making without being asked — the old
   * auto-caster could hand a lead the worst-graded voice in the set — but it is
   * still their cast, so it is never silent and never one-way.
   */
  function surfaceCastMigration() {
    const migration = scriptStore.pendingCastMigration;
    if (!migration) return;
    scriptStore.pendingCastMigration = null;

    const roleWord = migration.count === 1 ? 'role' : 'roles';
    showActionToast(
      `Recast ${migration.count} ${roleWord} with higher-quality voices`,
      'Undo',
      () => {
        if (!restoreCastBackup(migration.scriptKey)) return;
        audioManager.stop();
        scriptStore.setScriptData(scriptStore.currentScript, {
          scriptKey: scriptStore.scriptKey,
          scriptType: scriptStore.scriptType,
          sampleId: scriptStore.sampleId,
          customData: scriptStore.customScriptData,
          resetProgress: false
        });
        audioManager.setNarratorVoice(scriptStore.getNarratorVoice(audioManager.engineId));
        audioManager.setScript(
          scriptStore.currentScript.elements,
          scriptStore.castAssignments,
          scriptStore.activeLineIndex
        );
        castPanel.render();
        showResumeToast('Original cast restored.');
      }
    );
  }

  function surfaceLegacyCastOffer() {
    const candidate = scriptStore.pendingLegacyConfig;
    if (!candidate) return;
    scriptStore.pendingLegacyConfig = null;

    showActionToast(
      `Found an older saved cast for "${candidate.scriptTitle}"`,
      'Restore cast',
      () => {
        if (scriptStore.scriptKey !== candidate.scriptKey) return;
        audioManager.stop();
        scriptStore.setScriptData(scriptStore.currentScript, {
          scriptKey: scriptStore.scriptKey,
          scriptType: scriptStore.scriptType,
          sampleId: scriptStore.sampleId,
          customData: scriptStore.customScriptData,
          resetProgress: false,
          legacyConfigKey: candidate.legacyKey
        });
        audioManager.setNarratorVoice(scriptStore.getNarratorVoice(audioManager.engineId));
        audioManager.setScript(
          scriptStore.currentScript.elements,
          scriptStore.castAssignments,
          scriptStore.activeLineIndex
        );
        transportBar.updateProgress(
          scriptStore.activeLineIndex,
          scriptStore.currentScript.elements.length
        );
        const activeElem = scriptStore.currentScript.elements[scriptStore.activeLineIndex];
        if (activeElem) {
          transportBar.updateActiveSpeaker(
            activeElem,
            audioManager.getVoiceProfileForCharacter(activeElem.character),
            activeElem.nuance
          );
        }
      }
    );
  }

  scriptStore.subscribe(event => {
    if (event === 'scriptLoaded') {
      surfaceLegacyCastOffer();
      surfaceCastMigration();
    }
  });
  // The first script may already have loaded before this subscription existed.
  surfaceLegacyCastOffer();
  surfaceCastMigration();

  // Connect local-engine progress to the UI toast and header badge.
  //
  // Deliberately synchronous. This fires once per progress batch while hundreds
  // of megabytes stream, so anything awaited here piles up on the main thread and
  // freezes the very bar it is trying to update. A cache-status sweep is
  // especially costly, so the badge is refreshed on phase transitions instead.
  //
  // Both local engines are subscribed directly rather than through
  // audioManager.onEngineProgress, which follows whichever engine is *active*:
  // Studio Local is installed from the settings modal while Kokoro is still the
  // active engine, so an active-engine subscription would show nothing at all for
  // the one download that most needs a progress indicator.
  function engineProgressHandler(engine, label) {
    return ({ progress, message, phase }) => {
      if (phase === 'error') {
        // Terminal states are never suppressed. The modal shows its own error,
        // but a progress toast left behind it would go on claiming a download
        // that has already stopped.
        if (engineModalOpen) {
          dismissNeuralToast();
        } else {
          showNeuralErrorNotification(message, engine, label);
        }
        refreshEngineCacheBadge();
        return;
      }

      if (phase === 'idle') {
        // A cancelled install. Drop the toast rather than leaving it frozen
        // partway along a bar that will never move again.
        dismissNeuralToast();
        return;
      }

      if (phase === 'ready') {
        if (engineModalOpen) {
          dismissNeuralToast();
          refreshEngineCacheBadge();
          if (audioManager.engineId === engine.capabilities.id) audioManager.prewarm();
          return;
        }
        // The engine's own message already distinguishes "stored locally" from
        // "ready but the weights could not be retained" — don't second-guess it
        // here, both of the old strings claimed a cache that may not exist.
        removeNeuralLoadingNotification(message);
        refreshEngineCacheBadge();
        // Render the opening lines now so the first Play starts instantly — but
        // only for the engine that will actually be doing the rendering.
        if (audioManager.engineId === engine.capabilities.id) audioManager.prewarm();
        return;
      }

      // Loading updates only: while the settings modal is open its inline panel
      // is the contextual view, and a second copy of the same bar behind it would
      // freeze at whatever value it held when the modal opened.
      if (engineModalOpen) {
        dismissNeuralToast();
        return;
      }

      if (!neuralToast) {
        showNeuralLoadingNotification(label);
      }
      const msg = neuralToast ? neuralToast.querySelector('#neural-toast-msg') : null;
      const pct = neuralToast ? neuralToast.querySelector('#neural-toast-pct') : null;
      const fill = neuralToast ? neuralToast.querySelector('#neural-toast-fill') : null;
      if (msg) msg.textContent = message;
      if (pct) pct.textContent = `${progress}%`;
      if (fill) fill.style.width = `${progress}%`;
    };
  }

  audioManager.kokoroEngine.onProgress(
    engineProgressHandler(audioManager.kokoroEngine, 'Kokoro-82M')
  );
  const studioEngine = audioManager.getEngine(ENGINE_TYPES.CHATTERBOX);
  if (studioEngine) {
    studioEngine.onProgress(engineProgressHandler(studioEngine, 'Studio Local'));
  }

  function refreshEngineCacheBadge() {
    const engineId = audioManager.engineId;
    // Studio Local's install is eight files in OPFS, not one cached blob, so it
    // answers "is this ready offline?" through its own probe.
    if (engineId === ENGINE_TYPES.CHATTERBOX) {
      audioManager.getChatterboxCacheStatus()
        .then(status => header.updateEngineCacheBadge({ engineId, studioInstalled: status.installed }))
        .catch(err => console.warn('Studio Local cache status notice:', err));
      return;
    }
    audioManager.getCacheStatus()
      // The engine id rides along so a cloud session's badge is not overwritten
      // by a status report about Kokoro's weights.
      .then(status => header.updateEngineCacheBadge({ ...status, engineId }))
      .catch(err => console.warn('Cache status notice:', err));
  }

  // Initial check of local cache status
  refreshEngineCacheBadge();

  // Neural Loading Notification Toast
  let neuralToast = null;
  function showNeuralLoadingNotification(label = 'Kokoro-82M') {
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
        <span id="neural-toast-msg">Loading ${label}…</span>
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
  function showNeuralErrorNotification(message, engine = audioManager.kokoroEngine, label = 'Neural voice engine') {
    if (!neuralToast) showNeuralLoadingNotification(label);
    if (!neuralToast) return;

    neuralToast.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 0.8rem; font-weight: 600; color: #F87171;">
        <span>${label} unavailable</span>
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
        // Retry whichever engine actually failed. Hardcoding Kokoro here meant a
        // Studio Local failure offered a Retry button that reloaded the wrong
        // engine and left the broken one exactly as it was.
        engine.init().catch(() => {
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
      target.tagName === 'INPUT' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'BUTTON' ||
      target.isContentEditable
    );
    if (isTextInput) return;

    if (e.key === '?') {
      openHelpModal();
      return;
    }
    if (currentView !== APP_VIEWS.PLAYER) return;

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
      showLibraryTab('cast');
    } else if (e.key === 'v' || e.key === 'V') {
      openVoiceConfigModal(false);
    } else if (e.key === 's' || e.key === 'S') {
      showLibraryTab('scenes');
    }
  });

  window.addEventListener('beforeunload', () => {
    scriptStore.saveCurrentState();
  });

  // The chooser is always the front door. Saved state is represented as a
  // recent-script card and restored only after the listener asks for it.
  showWelcome();
}

// Start application
initApp().catch(err => console.error('App initialization error:', err));

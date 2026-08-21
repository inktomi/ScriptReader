import { PLAYBACK_STATES } from '../audio/audio-manager.js';
import { getIconSvg } from '../utils/icons.js';

export function createTransportBar({
  audioManager,
  scriptStore,
  onPlay,
  onPause,
  onStop,
  onSkipNext,
  onSkipPrev,
  onSeek,
  onExport,
  onCancelExport,
}) {
  const container = document.createElement('div');
  container.className = 'transport-container';

  container.innerHTML = `
    <div class="transport-main-row">
      <div class="current-reading-info">
        <div class="speaker-avatar-tiny" id="active-speaker-avatar">
          ${getIconSvg('mic', 15)}
        </div>
        <div class="speaker-info-text">
          <div class="speaker-title" id="active-speaker-name">Ready</div>
          <div class="speaker-emotion" id="active-speaker-emotion">Press Play to begin readthrough</div>
        </div>
      </div>

      <div class="playback-controls">
        <button id="btn-transport-prev" class="btn-transport" title="Previous Line (Left Arrow)">
          ${getIconSvg('skipBack', 20)}
        </button>

        <button id="btn-transport-play" class="btn-play-big" title="Play / Pause (Spacebar)">
          ${getIconSvg('play', 24)}
        </button>

        <button id="btn-transport-next" class="btn-transport" title="Next Line (Right Arrow)">
          ${getIconSvg('skipForward', 20)}
        </button>
      </div>

      <div class="transport-right">
        <div class="level-meter" title="Stereo output level">
          <span>L</span>
          <canvas class="visualizer-canvas" id="audio-visualizer-canvas"></canvas>
          <span>R</span>
        </div>
        <div class="volume-control" title="Volume">
          <button id="btn-transport-mute" class="btn-transport" style="width: 32px; height: 32px;">
            ${getIconSvg('volume', 16)}
          </button>
          <input type="range" id="transport-volume" class="slider-input" min="0" max="100" value="100" style="width: 76px;">
        </div>
        <details class="transport-options">
          <summary class="btn btn-quiet">${getIconSvg('sliders', 15)} Options</summary>
          <div class="transport-options-popover">
            <div class="transport-option-row">
              <span>Pacing</span>
              <div class="pacing-selector" title="Theatrical cue timing">
                <button class="pacing-chip active" data-pacing="natural">Natural</button>
                <button class="pacing-chip" data-pacing="dramatic">Dramatic</button>
                <button class="pacing-chip" data-pacing="snappy">Snappy</button>
              </div>
            </div>
            <div class="transport-option-row">
              <span>Speed</span>
              <div class="speed-chips" title="Playback speed">
                <button class="speed-chip" data-speed="0.75">0.75×</button>
                <button class="speed-chip active" data-speed="1.0">1.0×</button>
                <button class="speed-chip" data-speed="1.25">1.25×</button>
                <button class="speed-chip" data-speed="1.5">1.5×</button>
              </div>
            </div>
            <button id="btn-transport-stop" class="btn btn-quiet transport-reset" title="Stop and return to the beginning">
              ${getIconSvg('stop', 15)} Stop and reset
            </button>
          </div>
        </details>
      </div>
    </div>

    <div class="transport-render-row" id="transport-render-row" hidden>
      <div class="transport-render-copy">
        <span id="transport-render-label">Pre-rendering Studio Local audio</span>
        <span id="transport-render-detail"></span>
      </div>
      <button id="transport-render-download" class="btn btn-quiet transport-render-download" type="button" hidden
        title="Download the whole read as an audio file">
        ${getIconSvg('download', 14)}
        <span>Download audio</span>
      </button>
      <div class="transport-render-track" role="progressbar" aria-label="Studio Local pre-render progress"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <span id="transport-render-fill"></span>
      </div>
    </div>

    <div class="transport-render-row transport-export-row" id="transport-export-row" hidden>
      <div class="transport-render-copy">
        <span id="transport-export-label">Rendering the read</span>
        <span id="transport-export-detail"></span>
      </div>
      <button id="transport-export-cancel" class="btn btn-quiet" type="button" title="Stop the export">
        ${getIconSvg('stop', 14)}
        <span>Cancel</span>
      </button>
      <div class="transport-render-track" role="progressbar" aria-label="Audio export progress"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <span id="transport-export-fill"></span>
      </div>
    </div>

    <div class="transport-scrub-row">
      <span id="transport-line-counter">Line 0 / 0</span>
      <!-- The buffering notice sits left of the track, away from the scrub
           percentage. Adjacent, they read as one sentence — "Rendering
           voices… 3%" looked like render progress stuck at 3% when the 3%
           was the playhead's position in the script. -->
      <span id="transport-buffer-status" class="transport-buffer-status"></span>
      <div class="scrub-track" id="scrub-track" title="Click to jump to a line in the screenplay">
        <div class="scrub-fill" id="scrub-fill"></div>
      </div>
      <span id="transport-progress-percent" title="Position in the screenplay">0%</span>
    </div>
  `;

  // DOM Elements
  const btnPlay = container.querySelector('#btn-transport-play');
  const btnPrev = container.querySelector('#btn-transport-prev');
  const btnNext = container.querySelector('#btn-transport-next');
  const btnStop = container.querySelector('#btn-transport-stop');
  const scrubTrack = container.querySelector('#scrub-track');
  const scrubFill = container.querySelector('#scrub-fill');
  const lineCounter = container.querySelector('#transport-line-counter');
  const progressPercent = container.querySelector('#transport-progress-percent');
  const speakerAvatar = container.querySelector('#active-speaker-avatar');
  const speakerName = container.querySelector('#active-speaker-name');
  const speakerEmotion = container.querySelector('#active-speaker-emotion');
  const speedChips = container.querySelectorAll('.speed-chip');
  const pacingChips = container.querySelectorAll('.pacing-chip');
  const visualizerCanvas = container.querySelector('#audio-visualizer-canvas');
  const bufferStatus = container.querySelector('#transport-buffer-status');
  const volumeSlider = container.querySelector('#transport-volume');
  const btnMute = container.querySelector('#btn-transport-mute');
  const renderRow = container.querySelector('#transport-render-row');
  const renderLabel = container.querySelector('#transport-render-label');
  const renderDetail = container.querySelector('#transport-render-detail');
  const renderTrack = container.querySelector('#transport-render-row .transport-render-track');
  const renderFill = container.querySelector('#transport-render-fill');
  const renderDownload = container.querySelector('#transport-render-download');
  const exportRow = container.querySelector('#transport-export-row');
  const exportLabel = container.querySelector('#transport-export-label');
  const exportDetail = container.querySelector('#transport-export-detail');
  const exportTrack = container.querySelector('#transport-export-row .transport-render-track');
  const exportFill = container.querySelector('#transport-export-fill');
  const exportCancel = container.querySelector('#transport-export-cancel');
  let latestPlaybackState = PLAYBACK_STATES.IDLE;
  let latestRenderStatus = { visible: false, canPlay: true };
  let latestExportStatus = { active: false };

  function setPlayDisabled(disabled) {
    if (disabled && document.activeElement === btnPlay) btnPrev.focus();
    btnPlay.disabled = disabled;
  }

  // Volume + mute
  volumeSlider.addEventListener('input', (e) => {
    const value = parseInt(e.target.value, 10) / 100;
    audioManager.setVolume(value);
    if (value > 0 && audioManager.isMuted) {
      audioManager.setMuted(false);
      btnMute.classList.remove('btn-active');
    }
  });

  btnMute.addEventListener('click', () => {
    const nextMuted = !audioManager.isMuted;
    audioManager.setMuted(nextMuted);
    btnMute.classList.toggle('btn-active', nextMuted);
    btnMute.innerHTML = getIconSvg(nextMuted ? 'volumeMute' : 'volume', 16);
  });

  // Pacing mode chips
  pacingChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      pacingChips.forEach((c) => {
        c.classList.remove('active');
      });
      chip.classList.add('active');
      const mode = chip.dataset.pacing;
      audioManager.setPacingMode(mode);
    });
  });

  // Play / Pause toggle
  btnPlay.addEventListener('click', () => {
    // Buffering counts as "running" — the button has to stop it, not restart it.
    if (
      audioManager.playbackState === PLAYBACK_STATES.PLAYING ||
      audioManager.playbackState === PLAYBACK_STATES.BUFFERING
    ) {
      onPause();
    } else {
      onPlay();
    }
  });

  renderDownload.addEventListener('click', () => onExport?.());
  exportCancel.addEventListener('click', () => onCancelExport?.());

  btnPrev.addEventListener('click', onSkipPrev);
  btnNext.addEventListener('click', onSkipNext);
  btnStop.addEventListener('click', onStop);

  // Scrubber seeking
  scrubTrack.addEventListener('click', (e) => {
    const rect = scrubTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const totalLines = scriptStore.currentScript ? scriptStore.currentScript.elements.length : 0;
    if (totalLines > 0) {
      const targetIndex = Math.floor(ratio * totalLines);
      onSeek(targetIndex);
    }
  });

  // Speed chips
  speedChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      speedChips.forEach((c) => {
        c.classList.remove('active');
      });
      chip.classList.add('active');
      const speed = parseFloat(chip.dataset.speed);
      audioManager.setMasterSpeed(speed);
    });
  });

  function updatePlaybackState(state) {
    latestPlaybackState = state;
    const isBuffering = state === PLAYBACK_STATES.BUFFERING;
    container.classList.toggle('is-buffering', isBuffering);
    bufferStatus.textContent = isBuffering ? 'Rendering voices…' : '';

    if (state === PLAYBACK_STATES.PLAYING || isBuffering) {
      btnPlay.innerHTML = getIconSvg('pause', 24);
      btnPlay.dataset.state = isBuffering ? 'buffering' : 'playing';
    } else {
      btnPlay.innerHTML = getIconSvg('play', 24);
      btnPlay.dataset.state = 'idle';
    }
    setPlayDisabled(latestRenderStatus.visible && !latestRenderStatus.canPlay && state === PLAYBACK_STATES.IDLE);
  }

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 1) return '';
    if (seconds < 60) return 'less than a minute remaining';
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} remaining`;
  }

  function updateRenderProgress(status = {}) {
    latestRenderStatus = { ...latestRenderStatus, ...status };
    renderRow.hidden = !latestRenderStatus.visible;
    if (!latestRenderStatus.visible) {
      // Engines without a whole-script pre-render have no bar to hang the
      // affordance off; the header button is the entry point there.
      setDownloadVisible(false);
      setPlayDisabled(false);
      return;
    }

    const percent = Math.max(0, Math.min(100, Number(latestRenderStatus.percent) || 0));
    const engineLabel = latestRenderStatus.engineLabel || 'Studio Local';
    renderFill.style.width = `${percent}%`;
    renderTrack.setAttribute('aria-valuenow', String(percent));
    renderLabel.textContent = latestRenderStatus.error
      ? `${engineLabel} pre-render stopped`
      : `${engineLabel} pre-rendered · ${percent}%`;

    if (latestRenderStatus.error) {
      renderDetail.textContent = latestRenderStatus.error;
    } else if (!latestRenderStatus.active) {
      // `active` only says the render loop is not running — a paused or
      // abandoned run is idle too. Promising uninterrupted playback on that
      // alone is what put "Ready" above a Play button that could not start.
      // The idle-but-unready wording stays factual rather than telling anyone to
      // press Play when Play is disabled in the idle state. When paused, the
      // scheduled audio is held in place and can be resumed immediately.
      if (latestRenderStatus.canPlay) {
        renderDetail.textContent = 'Ready for uninterrupted playback';
      } else if (latestPlaybackState === PLAYBACK_STATES.PAUSED) {
        renderDetail.textContent = 'Playback paused — press Play to resume';
      } else {
        renderDetail.textContent = 'Pre-render paused — not ready yet';
      }
    } else if (latestRenderStatus.canPlay) {
      const eta = formatEta(latestRenderStatus.etaSeconds);
      renderDetail.textContent = `Ready to play · rendering continues${eta ? ` · ${eta}` : ''}`;
    } else {
      renderDetail.textContent = `Building a safe playback lead${formatEta(latestRenderStatus.etaSeconds) ? ` · ${formatEta(latestRenderStatus.etaSeconds)}` : ''}`;
    }

    // The whole script is banked, so the export is a cache read rather than a
    // re-render. That is the moment worth offering it right here, next to the
    // bar that just finished.
    const complete = percent >= 100 && latestRenderStatus.canPlay && !latestRenderStatus.error;
    setDownloadVisible(complete && !latestExportStatus.active);

    setPlayDisabled(
      latestRenderStatus.visible && !latestRenderStatus.canPlay && latestPlaybackState === PLAYBACK_STATES.IDLE,
    );
    btnPlay.title = btnPlay.disabled
      ? `${engineLabel} is rendering enough audio for uninterrupted playback`
      : 'Play / Pause (Spacebar)';
  }

  /**
   * The nearest control that can actually hold focus.
   *
   * Play is disabled whenever the pre-render has not reached a safe lead, and
   * focusing a disabled button is a no-op that drops the caret to the body -
   * which is the exact failure the focus hand-off exists to prevent.
   */
  function focusFallback() {
    if (!exportRow.hidden) return exportCancel;
    if (!renderDownload.hidden) return renderDownload;
    return btnPlay.disabled ? btnPrev : btnPlay;
  }

  function setDownloadVisible(visible) {
    if (renderDownload.hidden === !visible) return;
    // Hiding the control the caret is on would strand focus on the body.
    const hadFocus = !visible && document.activeElement === renderDownload;
    renderDownload.hidden = !visible;
    if (hadFocus) focusFallback().focus();
  }

  const EXPORT_PHASE_LABELS = {
    preparing: 'Preparing the export',
    rendering: 'Rendering the read',
    encoding: 'Finishing the audio',
    saving: 'Saving the file',
  };

  /**
   * Paint export progress in its own row.
   *
   * Separate from the pre-render row on purpose: they can be true at once (a
   * Studio script is pre-rendered *and* exporting), and collapsing them into one
   * bar would make each one's percentage look like the other's.
   */
  function updateExportProgress(status = {}) {
    const wasActive = latestExportStatus.active;
    const hadCancelFocus = document.activeElement === exportCancel;
    latestExportStatus = { ...latestExportStatus, ...status };

    const active = Boolean(latestExportStatus.active);
    exportRow.hidden = !active;

    if (active) {
      const percent = Math.max(0, Math.min(100, Number(latestExportStatus.percent) || 0));
      exportFill.style.width = `${percent}%`;
      exportTrack.setAttribute('aria-valuenow', String(percent));
      exportLabel.textContent = `${EXPORT_PHASE_LABELS[latestExportStatus.phase] || 'Exporting'} · ${percent}%`;
      const eta = formatEta(latestExportStatus.etaSeconds);
      exportDetail.textContent =
        latestExportStatus.phase === 'rendering' && eta ? eta : 'Keep this tab open until the file is saved';
      // Offering the same export from two controls at once invites a second
      // click that can only be refused.
      setDownloadVisible(false);
      return;
    }

    // Settle the pre-render row first: it owns the download affordance, and both
    // the failure notice and the focus hand-off below depend on whether that
    // button came back.
    updateRenderProgress({});
    if (latestExportStatus.error) {
      // The reason belongs where the listener was already looking.
      renderDetail.textContent = latestExportStatus.error;
    }
    if (wasActive && hadCancelFocus) {
      focusFallback().focus();
    }
  }

  function updateActiveSpeaker(element, voice, nuance, others = []) {
    if (!element) {
      speakerName.textContent = 'Ready';
      speakerEmotion.textContent = 'Press Play to begin readthrough';
      speakerAvatar.innerHTML = getIconSvg('mic', 15);
      speakerAvatar.style.background = '';
      return;
    }

    const name = element.characterOriginal || element.character;
    const alsoSpeaking = (others || []).filter(Boolean).map((other) => other.characterOriginal || other.character);
    speakerName.textContent = alsoSpeaking.length > 0 ? `${name} + ${alsoSpeaking.join(' + ')}` : name;

    const emotionText =
      alsoSpeaking.length > 0
        ? 'Talking over each other'
        : nuance && nuance.emotionKey && nuance.emotionKey !== 'neutral'
          ? `${nuance.emotionLabel} (${nuance.description})`
          : 'Natural Delivery';
    speakerEmotion.textContent = emotionText;

    if (element.character === 'NARRATOR') {
      speakerAvatar.innerHTML = getIconSvg('mic', 15);
      speakerAvatar.style.background = '';
    } else {
      speakerAvatar.innerHTML = element.character.substring(0, 2).toUpperCase();
      speakerAvatar.style.background = voice.avatarBg || 'linear-gradient(135deg, #8B5CF6, #6366F1)';
    }
  }

  function updateProgress(currentIndex, totalLines) {
    if (totalLines === 0) {
      lineCounter.textContent = 'Line 0 / 0';
      progressPercent.textContent = '0%';
      scrubFill.style.width = '0%';
      return;
    }

    const pct = Math.round(((currentIndex + 1) / totalLines) * 100);
    lineCounter.textContent = `Line ${currentIndex + 1} of ${totalLines}`;
    progressPercent.textContent = `${pct}%`;
    scrubFill.style.width = `${pct}%`;
  }

  return {
    element: container,
    visualizerCanvas,
    updatePlaybackState,
    updateRenderProgress,
    updateExportProgress,
    updateActiveSpeaker,
    updateProgress,
  };
}

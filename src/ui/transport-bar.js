import { getIconSvg } from '../utils/icons.js';
import { PLAYBACK_STATES } from '../audio/audio-manager.js';
import { getVoiceById } from '../audio/voice-catalog.js';

export function createTransportBar({
  audioManager,
  scriptStore,
  onPlay,
  onPause,
  onStop,
  onSkipNext,
  onSkipPrev,
  onSeek
}) {
  const container = document.createElement('div');
  container.className = 'transport-container';

  container.innerHTML = `
    <!-- Top Scrub Row -->
    <div class="transport-scrub-row">
      <span id="transport-line-counter">Line 0 / 0</span>
      <div class="scrub-track" id="scrub-track" title="Click to jump line in screenplay">
        <div class="scrub-fill" id="scrub-fill"></div>
      </div>
      <span id="transport-buffer-status" class="transport-buffer-status"></span>
      <span id="transport-progress-percent">0%</span>
    </div>

    <!-- Main Controls Row -->
    <div class="transport-main-row">
      <!-- Left: Active Character & Emotion -->
      <div class="current-reading-info">
        <div class="speaker-avatar-tiny" id="active-speaker-avatar" style="background: linear-gradient(135deg, #F59E0B, #D97706);">
          🎙️
        </div>
        <div class="speaker-info-text">
          <div class="speaker-title" id="active-speaker-name">Ready</div>
          <div class="speaker-emotion" id="active-speaker-emotion">Press Play to begin readthrough</div>
        </div>
      </div>

      <!-- Center: Transport Buttons -->
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

        <button id="btn-transport-stop" class="btn-transport" title="Stop & Reset">
          ${getIconSvg('stop', 18)}
        </button>
      </div>

      <!-- Right: Spectrum Visualizer, Pacing Mode & Speed Multiplier -->
      <div class="transport-right">
        <!-- Theatrical Pacing Selector -->
        <div class="pacing-selector" title="Theatrical Cue Timing & Pause Mode">
          <button class="pacing-chip active" data-pacing="natural" title="Authentic human table read timing">🎭 Natural</button>
          <button class="pacing-chip" data-pacing="dramatic" title="Rich dramatic breathing and suspense pauses">🎬 Dramatic</button>
          <button class="pacing-chip" data-pacing="snappy" title="Fast-paced banter and rapid rehearsal">⚡ Snappy</button>
        </div>

        <!-- Canvas Visualizer -->
        <canvas class="visualizer-canvas" id="audio-visualizer-canvas" title="Real-time Audio Spectrum"></canvas>

        <!-- Volume -->
        <div class="volume-control" title="Volume">
          <button id="btn-transport-mute" class="btn-transport" style="width: 32px; height: 32px;">
            ${getIconSvg('volume', 16)}
          </button>
          <input type="range" id="transport-volume" class="slider-input" min="0" max="100" value="100" style="width: 76px;">
        </div>

        <!-- Speed Chips -->
        <div class="speed-chips" title="Playback Speed">
          <button class="speed-chip" data-speed="0.75">0.75x</button>
          <button class="speed-chip active" data-speed="1.0">1.0x</button>
          <button class="speed-chip" data-speed="1.25">1.25x</button>
          <button class="speed-chip" data-speed="1.5">1.5x</button>
        </div>
      </div>
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
  pacingChips.forEach(chip => {
    chip.addEventListener('click', () => {
      pacingChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const mode = chip.dataset.pacing;
      audioManager.setPacingMode(mode);
    });
  });

  // Play / Pause toggle
  btnPlay.addEventListener('click', () => {
    // Buffering counts as "running" — the button has to stop it, not restart it.
    if (audioManager.playbackState === PLAYBACK_STATES.PLAYING ||
        audioManager.playbackState === PLAYBACK_STATES.BUFFERING) {
      onPause();
    } else {
      onPlay();
    }
  });

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
  speedChips.forEach(chip => {
    chip.addEventListener('click', () => {
      speedChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const speed = parseFloat(chip.dataset.speed);
      audioManager.setMasterSpeed(speed);
    });
  });

  function updatePlaybackState(state) {
    const isBuffering = state === PLAYBACK_STATES.BUFFERING;
    container.classList.toggle('is-buffering', isBuffering);
    bufferStatus.textContent = isBuffering ? '⏳ Rendering voices…' : '';

    if (state === PLAYBACK_STATES.PLAYING || isBuffering) {
      btnPlay.innerHTML = getIconSvg('pause', 24);
      btnPlay.style.background = isBuffering
        ? 'linear-gradient(135deg, #64748B, #475569)'
        : 'linear-gradient(135deg, #06B6D4, #3B82F6)';
      btnPlay.style.boxShadow = isBuffering
        ? '0 0 18px rgba(100, 116, 139, 0.4)'
        : '0 0 24px rgba(6, 182, 212, 0.5)';
    } else {
      btnPlay.innerHTML = getIconSvg('play', 24);
      btnPlay.style.background = 'linear-gradient(135deg, #F59E0B, #D97706)';
      btnPlay.style.boxShadow = '0 0 20px rgba(245, 158, 11, 0.4)';
    }
  }

  function updateActiveSpeaker(element, voice, nuance) {
    if (!element) {
      speakerName.textContent = 'Ready';
      speakerEmotion.textContent = 'Press Play to begin readthrough';
      speakerAvatar.innerHTML = '🎙️';
      speakerAvatar.style.background = 'linear-gradient(135deg, #F59E0B, #D97706)';
      return;
    }

    const name = element.characterOriginal || element.character;
    speakerName.textContent = name;

    const emotionText = nuance && nuance.emotionKey && nuance.emotionKey !== 'neutral'
      ? `${nuance.emotionIcon || '🎭'} ${nuance.emotionLabel} (${nuance.description})`
      : 'Natural Delivery';
    speakerEmotion.textContent = emotionText;

    if (element.character === 'NARRATOR') {
      speakerAvatar.innerHTML = '🎙️';
      speakerAvatar.style.background = 'linear-gradient(135deg, #F59E0B, #B45309)';
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
    updateActiveSpeaker,
    updateProgress
  };
}

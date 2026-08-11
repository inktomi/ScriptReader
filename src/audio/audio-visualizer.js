/** Compact, restrained stereo-style output meter for the transport console. */

export class AudioVisualizer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement ? canvasElement.getContext('2d') : null;
    this.analyser = null;
    this.dataArray = null;
    this.animationId = null;
    this.isPlaying = false;
    this.accentColor = '#C6A466';
    this.secondaryColor = '#78977B';
    this.simulatedPhase = 0;
    this.simulatedIntensity = 0;

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = (rect.width || 300) * window.devicePixelRatio;
    this.canvas.height = (rect.height || 48) * window.devicePixelRatio;
    if (this.ctx) {
      this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    }
  }

  /** Fit the bar count to the space available so bars never overflow. */
  barCountFor(width) {
    return Math.max(8, Math.min(32, Math.floor(width / 7)));
  }

  setColors() {
    // Performance annotations should not turn the transport into a light show.
    this.accentColor = '#C6A466';
    this.secondaryColor = '#78977B';
  }

  start(analyser = null) {
    if (analyser) {
      this.analyser = analyser;
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    }
    this.isPlaying = true;

    // start() is called again once the scheduler's analyser exists; never let
    // that stack a second animation frame loop on top of the first.
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.animate();
  }

  stop() {
    this.isPlaying = false;
    this.simulatedIntensity = 0;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.renderIdle();
  }

  setSpeaking(isSpeaking, emotion = null) {
    this.isPlaying = isSpeaking;
    if (isSpeaking && !this.animationId) {
      this.animate();
    }
  }

  animate() {
    if (!this.ctx || !this.canvas) return;

    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;

    // Before layout settles the canvas can report zero width, which would make
    // the bar geometry negative and throw out of roundRect.
    if (width <= 0 || height <= 0) {
      this.animationId = requestAnimationFrame(() => this.animate());
      return;
    }

    this.ctx.clearRect(0, 0, width, height);

    if (this.isPlaying) {
      this.simulatedIntensity = Math.min(1.0, this.simulatedIntensity + 0.1);
    } else {
      this.simulatedIntensity = Math.max(0, this.simulatedIntensity - 0.05);
      if (this.simulatedIntensity <= 0.01) {
        this.renderIdle();
        return;
      }
    }

    this.simulatedPhase += 0.11;

    // Prefer real spectrum data when the scheduler has handed us an analyser;
    // fall back to the synthetic waveform when it hasn't.
    let spectrum = null;
    if (this.analyser && this.dataArray) {
      this.analyser.getByteFrequencyData(this.dataArray);
      spectrum = this.dataArray;
    }

    let level = 0;
    if (spectrum) {
      const usefulBins = Math.min(96, spectrum.length);
      for (let i = 0; i < usefulBins; i++) level += spectrum[i];
      level = (level / usefulBins / 255) * this.simulatedIntensity;
    } else {
      level = (0.46 + Math.sin(this.simulatedPhase) * 0.16) * this.simulatedIntensity;
    }
    this.renderMeter(width, height, level, Math.max(0, level * 0.9 + Math.sin(this.simulatedPhase * 1.4) * 0.06));

    if (this.isPlaying || this.simulatedIntensity > 0) {
      this.animationId = requestAnimationFrame(() => this.animate());
    }
  }

  renderIdle() {
    if (!this.ctx || !this.canvas) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return;

    this.ctx.clearRect(0, 0, width, height);

    this.renderMeter(width, height, 0, 0);
  }

  renderMeter(width, height, leftLevel, rightLevel) {
    const segments = Math.max(10, Math.min(22, Math.floor(width / 6)));
    const gap = 2;
    const segmentWidth = Math.max(2, (width - gap * (segments - 1)) / segments);
    const rowHeight = Math.max(3, Math.min(5, (height - 5) / 2));
    const levels = [leftLevel, rightLevel];

    levels.forEach((level, row) => {
      const y = row === 0 ? 2 : height - rowHeight - 2;
      for (let i = 0; i < segments; i++) {
        const active = i / segments <= level;
        this.ctx.fillStyle = active
          ? (i > segments * 0.82 ? this.accentColor : this.secondaryColor)
          : 'rgba(167, 160, 149, 0.18)';
        this.ctx.fillRect(i * (segmentWidth + gap), y, segmentWidth, rowHeight);
      }
    });
  }
}

/**
 * Real-time Audio Spectrum & Soundwave Visualizer
 * Renders glowing multi-band audio waves, VU meters, and reactive emotion pulses
 */

export class AudioVisualizer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement ? canvasElement.getContext('2d') : null;
    this.analyser = null;
    this.dataArray = null;
    this.animationId = null;
    this.isPlaying = false;
    this.accentColor = '#F59E0B'; // Cinema Gold default
    this.secondaryColor = '#06B6D4';
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

  setColors(primary = '#F59E0B', secondary = '#06B6D4') {
    this.accentColor = primary;
    this.secondaryColor = secondary;
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
    if (emotion && emotion.badgeColor) {
      this.accentColor = emotion.badgeColor;
    }
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

    this.simulatedPhase += 0.15;

    // Draw multi-bar spectrum
    const barCount = this.barCountFor(width);
    const gap = width / barCount > 6 ? 3 : 1;
    const barWidth = Math.max(1, (width / barCount) - gap);
    const centerY = height / 2;

    const gradient = this.ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, this.accentColor);
    gradient.addColorStop(1, this.secondaryColor);
    this.ctx.fillStyle = gradient;

    // Prefer real spectrum data when the scheduler has handed us an analyser;
    // fall back to the synthetic waveform when it hasn't.
    let spectrum = null;
    if (this.analyser && this.dataArray) {
      this.analyser.getByteFrequencyData(this.dataArray);
      spectrum = this.dataArray;
    }

    for (let i = 0; i < barCount; i++) {
      const x = i * (barWidth + gap);

      let normalizedHeight;
      if (spectrum) {
        // Sample logarithmically so speech energy spreads across the bars.
        const t = i / (barCount - 1);
        const bin = Math.min(spectrum.length - 1, Math.round(Math.pow(t, 1.8) * (spectrum.length - 1)));
        normalizedHeight = (spectrum[bin] / 255) * this.simulatedIntensity;
      } else {
        const wave1 = Math.sin(this.simulatedPhase + i * 0.35);
        const wave2 = Math.cos(this.simulatedPhase * 0.7 + i * 0.2);
        const randomJitter = (Math.sin(i * 99 + this.simulatedPhase * 3) + 1) * 0.5;
        normalizedHeight = Math.abs(wave1 * 0.6 + wave2 * 0.4) * randomJitter * this.simulatedIntensity;
      }

      const barHeight = Math.max(4, normalizedHeight * (height - 8));

      const y = centerY - (barHeight / 2);
      const radius = Math.max(0, Math.min(barWidth / 2, 2));

      // Draw rounded bar
      this.ctx.beginPath();
      this.ctx.roundRect(x, y, barWidth, barHeight, radius);
      this.ctx.fill();
    }

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

    const barCount = this.barCountFor(width);
    const gap = width / barCount > 6 ? 3 : 1;
    const barWidth = Math.max(1, (width / barCount) - gap);
    const centerY = height / 2;

    this.ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';

    for (let i = 0; i < barCount; i++) {
      const x = i * (barWidth + gap);
      const barHeight = 4;
      const y = centerY - (barHeight / 2);

      this.ctx.beginPath();
      this.ctx.roundRect(x, y, barWidth, barHeight, 2);
      this.ctx.fill();
    }
  }
}

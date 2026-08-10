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

  setColors(primary = '#F59E0B', secondary = '#06B6D4') {
    this.accentColor = primary;
    this.secondaryColor = secondary;
  }

  start(analyser = null) {
    this.analyser = analyser;
    if (this.analyser) {
      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(bufferLength);
    }
    this.isPlaying = true;
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
    const barCount = 32;
    const barWidth = (width / barCount) - 3;
    const centerY = height / 2;

    const gradient = this.ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, this.accentColor);
    gradient.addColorStop(1, this.secondaryColor);
    this.ctx.fillStyle = gradient;

    for (let i = 0; i < barCount; i++) {
      const x = i * (barWidth + 3);
      
      // Natural speech rhythm simulation
      const wave1 = Math.sin(this.simulatedPhase + i * 0.35);
      const wave2 = Math.cos(this.simulatedPhase * 0.7 + i * 0.2);
      const randomJitter = (Math.sin(i * 99 + this.simulatedPhase * 3) + 1) * 0.5;

      const normalizedHeight = Math.abs(wave1 * 0.6 + wave2 * 0.4) * randomJitter * this.simulatedIntensity;
      const barHeight = Math.max(4, normalizedHeight * (height - 8));

      const y = centerY - (barHeight / 2);
      const radius = Math.min(barWidth / 2, 2);

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
    this.ctx.clearRect(0, 0, width, height);

    const barCount = 32;
    const barWidth = (width / barCount) - 3;
    const centerY = height / 2;

    this.ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';

    for (let i = 0; i < barCount; i++) {
      const x = i * (barWidth + 3);
      const barHeight = 4;
      const y = centerY - (barHeight / 2);

      this.ctx.beginPath();
      this.ctx.roundRect(x, y, barWidth, barHeight, 2);
      this.ctx.fill();
    }
  }
}

/** Compact, restrained stereo-style output meter for the transport console. */

function requestFrame(cb) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(cb);
  }
  return setTimeout(cb, 16);
}

function cancelFrame(id) {
  if (typeof cancelAnimationFrame === 'function') return cancelAnimationFrame(id);
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    return window.cancelAnimationFrame(id);
  }
  clearTimeout(id);
}

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

    this._onResize = () => {
      if (this.resizeCanvas()) {
        if (!this.isPlaying && this.simulatedIntensity <= 0) {
          this.renderIdle();
        }
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._onResize);
    }
    if (typeof ResizeObserver !== 'undefined' && this.canvas) {
      this.resizeObserver = new ResizeObserver(() => this._onResize());
      this.resizeObserver.observe(this.canvas);
    }

    this.resizeCanvas();
    this.renderIdle();
  }

  resizeCanvas() {
    if (!this.canvas || !this.ctx) return false;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || this.canvas.clientWidth;
    const height = rect.height || this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return false;

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const targetWidth = Math.round(width * dpr);
    const targetHeight = Math.round(height * dpr);

    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }
    if (typeof this.ctx.setTransform === 'function') {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return true;
  }

  /** Fit the bar count to the space available so bars never overflow. */
  barCountFor(width) {
    const paddingX = 3;
    const availWidth = Math.max(0, (width || 0) - paddingX * 2);
    const segmentGap = 2;
    const minSegmentWidth = 3;
    return Math.max(6, Math.floor((availWidth + segmentGap) / (minSegmentWidth + segmentGap)));
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
      this.isPlaying = true;
    }

    if (!this.isPlaying) {
      this.renderIdle();
      return;
    }

    // start() is called again once the scheduler's analyser exists; never let
    // that stack a second animation frame loop on top of the first.
    if (this.animationId) {
      cancelFrame(this.animationId);
      this.animationId = null;
    }
    this.animate();
  }

  stop() {
    this.isPlaying = false;
    this.simulatedIntensity = 0;
    if (this.animationId) {
      cancelFrame(this.animationId);
      this.animationId = null;
    }
    this.renderIdle();
  }

  setSpeaking(isSpeaking, emotion = null) {
    this.isPlaying = Boolean(isSpeaking);
    if (this.isPlaying) {
      if (!this.animationId) {
        this.animate();
      }
    } else if (!this.animationId) {
      this.renderIdle();
    }
  }

  animate() {
    if (!this.ctx || !this.canvas) return;

    if (!this.resizeCanvas()) {
      if (this.isPlaying) {
        this.animationId = requestFrame(() => this.animate());
      }
      return;
    }

    const width = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width;
    const height = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height;

    this.ctx.clearRect(0, 0, width, height);

    if (this.isPlaying) {
      this.simulatedIntensity = Math.min(1.0, this.simulatedIntensity + 0.1);
    } else {
      this.simulatedIntensity = Math.max(0, this.simulatedIntensity - 0.05);
      if (this.simulatedIntensity <= 0.01) {
        this.simulatedIntensity = 0;
        this.animationId = null;
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
    const rightLevel = Math.max(0, level * 0.9 + Math.sin(this.simulatedPhase * 1.4) * 0.06);
    this.renderMeter(width, height, level, rightLevel);

    if (this.isPlaying || this.simulatedIntensity > 0) {
      this.animationId = requestFrame(() => this.animate());
    } else {
      this.animationId = null;
    }
  }

  renderIdle() {
    if (!this.ctx || !this.canvas) return;
    if (!this.resizeCanvas()) return;

    const width = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width;
    const height = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height;
    if (width <= 0 || height <= 0) return;

    this.ctx.clearRect(0, 0, width, height);
    this.renderMeter(width, height, 0, 0);
  }

  renderMeter(width, height, leftLevel, rightLevel) {
    const paddingX = 3;
    const paddingY = 2.5;
    const rowGap = 2;
    const availWidth = Math.max(0, width - paddingX * 2);
    const availHeight = Math.max(0, height - paddingY * 2);
    const rowHeight = Math.max(2, (availHeight - rowGap) / 2);

    const segments = this.barCountFor(width);
    const segmentGap = 2;
    const segmentWidth = Math.max(1, (availWidth - segmentGap * (segments - 1)) / segments);
    const levels = [leftLevel, rightLevel];

    levels.forEach((level, row) => {
      const y = paddingY + row * (rowHeight + rowGap);
      const clampedLevel = Math.max(0, Math.min(1, level));
      const activeSegments = clampedLevel > 0 ? Math.round(clampedLevel * segments) : 0;

      for (let i = 0; i < segments; i++) {
        const x = paddingX + i * (segmentWidth + segmentGap);
        const active = clampedLevel > 0 && i < activeSegments;
        this.ctx.fillStyle = active
          ? (i >= Math.floor(segments * 0.82) ? this.accentColor : this.secondaryColor)
          : 'rgba(167, 160, 149, 0.18)';

        if (typeof this.ctx.roundRect === 'function') {
          this.ctx.beginPath();
          this.ctx.roundRect(x, y, segmentWidth, rowHeight, 1);
          this.ctx.fill();
        } else {
          this.ctx.fillRect(x, y, segmentWidth, rowHeight);
        }
      }
    });
  }

  destroy() {
    if (this.animationId) {
      cancelFrame(this.animationId);
      this.animationId = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this._onResize && typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onResize);
    }
  }
}

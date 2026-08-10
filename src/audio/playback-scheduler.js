import { getAudioContext } from './audio-context.js';

/**
 * Gapless playback scheduler.
 *
 * Units are placed on the AudioContext's own timeline — `source.start(when)` —
 * rather than being chained off `onended` callbacks. The audio hardware then
 * runs the sequence at sample accuracy, so a slow main thread, a garbage
 * collection pause, or a repainting teleprompter cannot open a hole between
 * two lines. `nextStartTime` is the running edge of everything scheduled so far.
 */

const MIN_LEAD = 0.03;      // never schedule closer than this to "now"
const RELEASE_TIME = 0.012; // fade used when cutting playback short

export class PlaybackScheduler {
  constructor() {
    this.ctx = getAudioContext();
    this.active = [];
    this.nextStartTime = 0;
    this.volume = 1.0;
    this.isMuted = false;

    if (this.ctx) {
      this.master = this.ctx.createGain();
      this.master.gain.value = 1.0;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;

      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
  }

  get currentTime() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * Seconds of *real audio* scheduled beyond the playhead.
   *
   * With nothing scheduled this must read zero, not the distance to a freshly
   * reset timeline edge — otherwise an empty pipeline looks like a full one and
   * playback reports itself running before a single sample has been rendered.
   */
  get bufferedAhead() {
    if (this.active.length === 0) return 0;
    return Math.max(0, this.nextStartTime - this.currentTime);
  }

  setVolume(volume) {
    this.volume = Math.min(1, Math.max(0, volume));
    this._applyMasterGain();
  }

  setMuted(isMuted) {
    this.isMuted = !!isMuted;
    this._applyMasterGain();
  }

  _applyMasterGain() {
    if (!this.master || !this.ctx) return;
    const target = this.isMuted ? 0.0001 : Math.max(0.0001, this.volume);
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015);
  }

  /**
   * Build the per-unit signal chain. Filters are how a table read conveys that a
   * voice is coming through a radio or from off-screen rather than in the room.
   */
  _buildChain(unit, source) {
    const ctx = this.ctx;
    let head = source;
    let makeupGain = 1.0;

    if (unit.filter === 'radio') {
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 520;

      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 3200;

      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 2000;
      presence.Q.value = 1.1;
      presence.gain.value = 6;

      head.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(presence);
      head = presence;
      makeupGain = 1.7; // band-limiting costs a lot of level
    } else if (unit.filter === 'distant') {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 1900;
      lowpass.Q.value = 0.7;

      head.connect(lowpass);
      head = lowpass;
      makeupGain = 0.72;
    }

    const gainNode = ctx.createGain();
    // Short ramp in and out removes the click a hard buffer edge would produce.
    gainNode.gain.value = unit.gain * makeupGain;

    head.connect(gainNode);
    gainNode.connect(this.master);

    return gainNode;
  }

  /**
   * Place one unit immediately after everything already scheduled.
   * @returns {{startAt: number, endAt: number}}
   */
  schedule(unit, audioBuffer) {
    const ctx = this.ctx;
    if (!ctx) return { startAt: 0, endAt: 0 };

    const startAt = Math.max(
      this.nextStartTime + (unit.leadPause || 0),
      ctx.currentTime + MIN_LEAD
    );

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = unit.playbackRate || 1.0;

    const gainNode = this._buildChain(unit, source);

    const duration = audioBuffer.duration / (unit.playbackRate || 1.0);
    const endAt = startAt + duration;

    source.start(startAt);

    const entry = { source, gainNode, startAt, endAt, unit };
    this.active.push(entry);

    source.onended = () => {
      const idx = this.active.indexOf(entry);
      if (idx !== -1) this.active.splice(idx, 1);
      try {
        gainNode.disconnect();
      } catch (err) {
        // already torn down
      }
    };

    this.nextStartTime = endAt;
    return { startAt, endAt };
  }

  /**
   * Reset the timeline edge. Used when starting fresh or recovering from a stall
   * so the next unit plays now instead of at a stale timestamp.
   */
  resetTimeline(at = null) {
    if (!this.ctx) return;
    this.nextStartTime = at !== null ? at : this.ctx.currentTime;
  }

  /** Cut everything currently sounding or scheduled. */
  stopAll() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    for (const entry of this.active.slice()) {
      try {
        // Fade sources that are already audible; kill future ones outright.
        if (entry.startAt <= now) {
          entry.gainNode.gain.cancelScheduledValues(now);
          entry.gainNode.gain.setValueAtTime(entry.gainNode.gain.value, now);
          entry.gainNode.gain.linearRampToValueAtTime(0.0001, now + RELEASE_TIME);
          entry.source.stop(now + RELEASE_TIME);
        } else {
          entry.source.stop(now);
        }
      } catch (err) {
        // Source may have finished between the check and the call.
      }
    }

    this.active.length = 0;
    this.nextStartTime = now;
  }

  getAnalyser() {
    return this.analyser || null;
  }
}

import { getAudioContext } from './audio-context.js';

/**
 * Gapless playback scheduler.
 *
 * Units are placed on the AudioContext's own timeline — `source.start(when)` —
 * rather than being chained off `onended` callbacks. The audio hardware then
 * runs the sequence at sample accuracy, so a slow main thread, a garbage
 * collection pause, or a repainting teleprompter cannot open a hole between
 * two lines.
 *
 * Because characters can talk over each other, "the edge of what is scheduled"
 * is not one number. A unit declares which edge it measures from via `anchor`:
 *
 *   sequential — after everything scheduled so far        (the ordinary case)
 *   prevTail   — relative to where the current cluster's audio *would* have
 *                ended, so an interrupter lands on the tail of its victim
 *   prevHead   — relative to where the current line *started*, so two
 *                simultaneous speakers begin together
 *   chunk      — after the previous chunk of the same line
 *
 * Invariant: `timelineEnd` never moves backwards. A short line overlapping a
 * long one must not shrink the buffered horizon, or the manager will read the
 * collapse as starvation and stack the next line on top of the one still
 * sounding.
 */

const MIN_LEAD = 0.03; // never schedule closer than this to "now"
const RELEASE_TIME = 0.012; // fade used when cutting playback short
const INTERRUPT_FADE = 0.08; // fade applied when a line is cut off mid-thought
const MIN_AUDIBLE = 0.06; // a trimmed unit never collapses below this
const MIX_HEADROOM = 0.76; // leave room for two actors and filter makeup gain
const MAX_UNIT_GAIN = 1.1; // one actor cannot overload the mix bus alone

export class PlaybackScheduler {
  constructor() {
    this.ctx = getAudioContext();
    this.active = [];

    // Monotonic max of EFFECTIVE (post-truncation) end times. Drives bufferedAhead.
    this.timelineEnd = 0;
    // startAt of the most recent first-chunk — the anchor for simultaneous speech.
    this.curLineHead = 0;
    // NATURAL (pre-truncation) tail of the current overlap cluster, maxed across
    // its members — the anchor for an interrupter.
    this.curLineTail = 0;
    // Natural end of the most recently scheduled unit — the anchor for the next
    // chunk of the same line. Distinct from curLineTail: inside a cluster the
    // tail is the *maximum* across speakers, which is not where this line's own
    // next chunk belongs.
    this.lastUnitEnd = 0;

    this.volume = 1.0;
    this.isMuted = false;

    if (this.ctx) {
      this.master = this.ctx.createGain();
      this.master.gain.value = MIX_HEADROOM;

      // Speech peaks add quickly when actors overlap. The compressor is the
      // final safety stage: transparent on ordinary dialogue, progressively
      // limiting only the peaks that would clip at the destination.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.001;
      this.limiter.release.value = 0.12;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;

      this.master.connect(this.limiter);
      this.limiter.connect(this.analyser);
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
    return Math.max(0, this.timelineEnd - this.currentTime);
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
    const target = this.isMuted ? 0.0001 : Math.max(0.0001, this.volume * MIX_HEADROOM);
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015);
  }

  /**
   * Build the per-unit signal chain:
   *
   *   source → [filters] → gain → panner → master
   *
   * Filters are how a table read conveys that a voice is coming through a radio
   * or from off-screen rather than in the room. The panner is where each
   * character sits at the table, which is what keeps two people talking at once
   * intelligible rather than mush.
   *
   * Node order is deliberate. The panner goes after the filters because a
   * BiquadFilterNode adapts its channel count to its input, so panning first
   * would double the filter work for identical output. It goes after the gain
   * because the interrupt fade automates that node, and keeping the fade on a
   * mono node keeps it cheap and separate from the pan law.
   *
   * @returns {{gainNode: GainNode, tailNode: AudioNode}} the node to automate,
   *          and the last node in the chain (both need disconnecting).
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

    // StereoPannerNode already uses a constant-power law. Compensating that law
    // with sqrt(2) made each centred voice full-scale in both channels and left
    // no headroom for a second actor.
    const panNode = ctx.createStereoPanner();
    panNode.pan.value = Math.max(-1, Math.min(1, unit.pan || 0));
    gainNode.gain.value = Math.min(MAX_UNIT_GAIN, Math.max(0, unit.gain * makeupGain));

    head.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(this.master);

    return { gainNode, tailNode: panNode };
  }

  /**
   * Place one unit on the timeline, relative to the edge its `anchor` names.
   * @returns {{startAt: number, endAt: number, naturalEnd: number, truncated: boolean}}
   */
  schedule(unit, audioBuffer) {
    const ctx = this.ctx;
    if (!ctx) return { startAt: 0, endAt: 0, naturalEnd: 0, truncated: false };

    const rate = unit.playbackRate || 1.0;
    const natural = audioBuffer.duration / rate;

    // A cut-off line is trimmed relative to its OWN natural end. Expressing it
    // that way is what breaks the circular dependency: when the victim is
    // scheduled the interrupter's absolute start is not known yet, but "the
    // interrupter arrives `overlap` before I would have finished" is local.
    const trim = unit.trimTailSec || 0;
    const play = trim > 0 ? Math.max(MIN_AUDIBLE, natural - trim) : natural;

    // Read the anchor BEFORE any edge is updated.
    const base =
      unit.anchor === 'prevHead'
        ? this.curLineHead
        : unit.anchor === 'prevTail'
          ? this.curLineTail
          : unit.anchor === 'chunk'
            ? this.lastUnitEnd
            : this.timelineEnd;

    const startAt = Math.max(base + (unit.leadPause || 0), ctx.currentTime + MIN_LEAD);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = rate;

    const { gainNode, tailNode } = this._buildChain(unit, source);

    const naturalEnd = startAt + natural;
    const interruptFade = unit.interruptFadeSec || INTERRUPT_FADE;
    const endAt = trim > 0 ? startAt + play + interruptFade : naturalEnd;

    source.start(startAt);

    if (trim > 0) {
      const cut = startAt + play;
      gainNode.gain.setValueAtTime(gainNode.gain.value, cut);
      gainNode.gain.linearRampToValueAtTime(0.0001, cut + interruptFade);
      source.stop(cut + interruptFade);
    }

    const entry = { source, gainNode, tailNode, startAt, endAt, unit };
    this.active.push(entry);

    source.onended = () => {
      const idx = this.active.indexOf(entry);
      if (idx !== -1) this.active.splice(idx, 1);
      try {
        gainNode.disconnect();
        if (tailNode !== gainNode) tailNode.disconnect();
      } catch (_err) {
        // already torn down
      }
    };

    if (unit.isFirstChunk) this.curLineHead = startAt;

    // A sequential first chunk opens a new cluster, so the tail restarts there.
    // Anything else is a member of the cluster already in flight and extends it.
    this.curLineTail =
      unit.isFirstChunk && (!unit.anchor || unit.anchor === 'sequential')
        ? naturalEnd
        : Math.max(this.curLineTail, naturalEnd);

    this.lastUnitEnd = naturalEnd;
    this.timelineEnd = Math.max(this.timelineEnd, endAt);

    return { startAt, endAt, naturalEnd, truncated: trim > 0 };
  }

  /**
   * Reset every timeline edge. Used when starting fresh or recovering from a
   * stall so the next unit plays now instead of at a stale timestamp. Collapsing
   * all four to one instant is also what makes seeking directly onto an
   * interrupter degrade cleanly into an ordinary sequential start.
   */
  resetTimeline(at = null) {
    if (!this.ctx) return;
    const t = at !== null ? at : this.ctx.currentTime;
    this.timelineEnd = t;
    this.curLineHead = t;
    this.curLineTail = t;
    this.lastUnitEnd = t;
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
      } catch (_err) {
        // Source may have finished between the check and the call.
      }
    }

    this.active.length = 0;
    this.timelineEnd = now;
    this.curLineHead = now;
    this.curLineTail = now;
    this.lastUnitEnd = now;
  }

  getAnalyser() {
    return this.analyser || null;
  }
}

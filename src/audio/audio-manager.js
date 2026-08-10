import { WebSpeechEngine } from './web-speech-engine.js';
import { KokoroNeuralEngine } from './kokoro-engine.js';
import { ModelCacheManager, DEFAULT_MODEL_ID } from './model-cache-manager.js';
import { getVoiceById } from './voice-catalog.js';
import { PlaybackScheduler } from './playback-scheduler.js';
import { buildLineUnits, buildPreviewUnits, computeCueGapMs } from './performance-director.js';
import { getAudioContext, resumeAudioContext, suspendAudioContext } from './audio-context.js';

export const ENGINE_TYPES = {
  KOKORO_NEURAL: 'kokoro_neural',
  WEB_SPEECH: 'web_speech'
};

export const PLAYBACK_STATES = {
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
  BUFFERING: 'buffering'
};

export const PACING_MODES = {
  NATURAL: 'natural',   // Authentic human table read
  DRAMATIC: 'dramatic', // Rich theatrical breathing and tension
  SNAPPY: 'snappy'      // Rapid rehearsal readthrough
};

// How often the orchestration loop runs. Scheduling happens far enough ahead
// that this interval only needs to be comfortably faster than the horizon.
const TICK_MS = 60;

// Seconds of audio kept committed to the AudioContext timeline.
const SCHEDULE_AHEAD_SEC = 1.6;

// Seconds of audio kept *requested* from the worker, and a hard unit cap so a
// script of short lines cannot flood the queue.
const LOOKAHEAD_SEC = 28;
const LOOKAHEAD_UNITS = 24;

// Audio banked before the first line plays, versus after recovering a stall.
// Starting with a cushion is what turns "press play, hear a stutter" into
// "press play, sit back".
const PRIME_SECONDS_INITIAL = 3.0;
const PRIME_SECONDS_RECOVER = 1.5;
const PRIME_TIMEOUT_MS = 20000;

// Highlight the line a beat before its audio, so the teleprompter never lags.
const PLAYHEAD_LEAD_SEC = 0.02;

// How far apart the cast is seated. Wide enough that two simultaneous voices
// separate cleanly, narrow enough that nobody sounds like they left the room.
const PAN_SPREAD = 0.35;

// Playhead entries are kept this long past their end before being pruned.
const PLAYHEAD_RETAIN_SEC = 5;

export class ScreenplayAudioManager {
  constructor() {
    this.webSpeechEngine = new WebSpeechEngine();
    this.kokoroEngine = new KokoroNeuralEngine();
    this.modelCacheManager = ModelCacheManager;
    this.activeEngineType = ENGINE_TYPES.KOKORO_NEURAL;

    this.scheduler = null;

    this.scriptElements = [];
    this.characterAssignments = new Map();
    this.narratorVoiceId = 'bm_george';

    this.currentIndex = 0;
    this.playbackState = PLAYBACK_STATES.IDLE;
    this.pacingMode = PACING_MODES.NATURAL;
    this.masterSpeed = 1.0;
    this.volume = 1.0;
    this.isMuted = false;

    this.visualizer = null;
    this.listeners = new Set();

    // Render pipeline state
    this.unitCache = new Map();   // lineIndex -> unit[]
    this.cursorLine = 0;          // next line to schedule
    this.cursorUnit = 0;          // next chunk within that line
    this.stageOrder = [];         // speaking characters, most lines first — drives panning

    // Playhead bookkeeping. Overlapping speech means more than one line can be
    // sounding at once, so "the active line" is a set, and a line ends when its
    // own audio ends — not when some other line happens to start.
    this.pendingStarts = [];        // [{ lineIndex, startAt, overlapMode }] not yet announced
    this.lineEndAt = new Map();     // lineIndex -> latest effective end time
    this.lineComplete = new Map();  // lineIndex -> its last chunk has been scheduled
    this.lineTruncated = new Map(); // lineIndex -> it was cut off by an interrupter
    this.activeLines = new Map();   // lineIndex -> element, currently sounding
    this.hasStartedAnyLine = false;
    this.clusterRemaining = 0;      // units left to place in the cluster being scheduled

    this.reachedEnd = false;
    this.primed = false;
    this.primeDeadline = 0;
    this.tickHandle = null;

    // Bumped by every stop/seek/play. `play()` has to await engine init and the
    // audio context, and a seek arriving during those awaits must not leave two
    // start-ups racing to schedule from different cursors.
    this.playGeneration = 0;

    this.previewToken = 0;
    this._previewResolve = null;
    this.webSpeechToken = 0;
    this._webSpeechTimer = null;
    this.usingWebSpeechFallback = false;
  }

  async init() {
    await this.webSpeechEngine.init();
    // Warm the neural model in the background so the first Play is instant.
    this.kokoroEngine.init().catch(err => {
      console.warn('Kokoro background preload notice:', err);
    });
  }

  async getCacheStatus() {
    return await ModelCacheManager.getModelCacheStatus(DEFAULT_MODEL_ID);
  }

  // ---------------------------------------------------------------- listeners

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(eventType, data) {
    for (const listener of this.listeners) {
      try {
        listener(eventType, data);
      } catch (err) {
        console.error('Audio manager listener error:', err);
      }
    }
  }

  _setState(state) {
    if (this.playbackState === state) return;
    this.playbackState = state;
    this.emit('stateChange', { state });
  }

  // ------------------------------------------------------------ configuration

  setVisualizer(visualizer) {
    this.visualizer = visualizer;
    if (visualizer && this.scheduler) {
      visualizer.start(this.scheduler.getAnalyser());
    }
  }

  setPacingMode(pacingMode) {
    const next = pacingMode || PACING_MODES.NATURAL;
    if (next === this.pacingMode) return;
    this.pacingMode = next;
    this._invalidateUnits();
    this.emit('pacingChange', { pacingMode: this.pacingMode });
    // Pacing now moves delivery speed as well as the gaps, so it changes what
    // gets synthesised. Restarting matches how a speed change already behaves —
    // without it the new pacing would only appear on lines not yet rendered,
    // which sounds like the control half-worked.
    this._restartIfPlaying();
  }

  setEngineType(engineType) {
    if (engineType === this.activeEngineType) return;
    this.stop();
    this.activeEngineType = engineType;
    this.emit('engineChange', { engineType });
  }

  setScript(elements, characterMap = new Map(), startIndex = 0) {
    this.stop();
    this.scriptElements = elements || [];
    this.characterAssignments = characterMap;
    this.currentIndex = Math.max(0, Math.min(this.scriptElements.length - 1, startIndex || 0));
    this._buildStageOrder();
    this._invalidateUnits();
    this.emit('scriptLoaded', {
      totalLines: this.scriptElements.length,
      currentIndex: this.currentIndex
    });
    this.prewarm();
  }

  setVoiceAssignment(characterName, assignment) {
    this.characterAssignments.set(characterName.toUpperCase().trim(), assignment);
    this._invalidateUnits();
  }

  setNarratorVoice(voiceId) {
    if (this.narratorVoiceId === voiceId) return;
    this.narratorVoiceId = voiceId;
    this._invalidateUnits();
  }

  setMasterSpeed(speed) {
    const next = Math.min(2.0, Math.max(0.5, speed));
    if (next === this.masterSpeed) return;
    this.masterSpeed = next;
    this._invalidateUnits();
    this.emit('speedChange', { speed: this.masterSpeed });
    this._restartIfPlaying();
  }

  setVolume(volume) {
    this.volume = Math.min(1.0, Math.max(0, volume));
    if (this.scheduler) this.scheduler.setVolume(this.volume);
    this.emit('volumeChange', { volume: this.volume });
  }

  setMuted(isMuted) {
    this.isMuted = !!isMuted;
    if (this.scheduler) this.scheduler.setMuted(this.isMuted);
    this.emit('volumeChange', { volume: this.volume, isMuted: this.isMuted });
  }

  getVoiceProfileForCharacter(characterName) {
    const cleanName = (characterName || '').toUpperCase().trim();
    if (this._isNarratorName(cleanName)) {
      return getVoiceById(this.narratorVoiceId || 'bm_george');
    }

    const assignment = this.characterAssignments.get(cleanName);
    if (assignment && assignment.voiceId) {
      return getVoiceById(assignment.voiceId);
    }
    return getVoiceById('am_adam');
  }

  getCharacterSettings(characterName) {
    const cleanName = (characterName || '').toUpperCase().trim();
    const assignment = this.characterAssignments.get(cleanName);
    return {
      pitchOffset: assignment ? (assignment.pitchOffset || 0) : 0,
      speedMultiplier: assignment ? (assignment.speedMultiplier || 1.0) : 1.0
    };
  }

  /**
   * Seat the cast, biggest parts first. Derived from the elements rather than
   * from `script.characters` because `setScript` is only ever handed elements,
   * and this way PDF and Fountain scripts stage identically.
   */
  _buildStageOrder() {
    const counts = new Map();
    for (const element of this.scriptElements) {
      if (element.type !== 'DIALOGUE') continue;
      const name = (element.character || '').toUpperCase().trim();
      if (!name || this._isNarratorName(name)) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    this.stageOrder = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);
  }

  _isNarratorName(cleanName) {
    return cleanName === 'NARRATOR' || cleanName.includes('SCENE') || cleanName === 'STAGE';
  }

  /**
   * Where a character sits in the stereo field. Stable for the whole read, so
   * a voice never wanders — the spread is what makes two people talking at once
   * possible to follow at all. The narrator stays dead centre, addressing the
   * room rather than sitting at the table.
   */
  getPanForCharacter(characterName) {
    const cleanName = (characterName || '').toUpperCase().trim();
    if (!cleanName || this._isNarratorName(cleanName)) return 0;

    const assignment = this.characterAssignments.get(cleanName);
    if (assignment && typeof assignment.pan === 'number') {
      return Math.max(-1, Math.min(1, assignment.pan));
    }

    const slot = this.stageOrder.indexOf(cleanName);
    if (slot < 0) return 0;

    // Alternate sides and fill inward, so the leads take the outer chairs.
    const sign = slot % 2 === 0 ? -1 : 1;
    const tier = Math.floor(slot / 2);
    return sign * PAN_SPREAD * (1 - (tier % 3) * 0.30);
  }

  // ----------------------------------------------------------- render pipeline

  _invalidateUnits() {
    this.unitCache.clear();
  }

  /** Forget everything the playhead knows. Called whenever the timeline is torn down. */
  _resetPlayheadState() {
    this.pendingStarts = [];
    this.lineEndAt.clear();
    this.lineComplete.clear();
    this.lineTruncated.clear();
    this.activeLines.clear();
    this.hasStartedAnyLine = false;
    this.clusterRemaining = 0;
  }

  /**
   * Units for a line, memoised. Returns null past the end of the script and an
   * empty array for lines with nothing speakable (e.g. bare punctuation).
   */
  _unitsForLine(lineIndex) {
    if (lineIndex < 0 || lineIndex >= this.scriptElements.length) return null;

    const cached = this.unitCache.get(lineIndex);
    if (cached) return cached;

    const element = this.scriptElements[lineIndex];
    const units = buildLineUnits({
      element,
      prevElement: lineIndex > 0 ? this.scriptElements[lineIndex - 1] : null,
      lineIndex,
      voiceProfile: this.getVoiceProfileForCharacter(element.character),
      tuning: this.getCharacterSettings(element.character),
      pan: this.getPanForCharacter(element.character),
      masterSpeed: this.masterSpeed,
      pacing: this.pacingMode
    });

    this.unitCache.set(lineIndex, units);
    return units;
  }

  /**
   * The run of lines that must go onto the timeline together: a line plus every
   * line that follows it speaking over it. Overlap is expressed as a start time
   * relative to a neighbour, so placing half a cluster and coming back later
   * would resolve those anchors against a stale edge.
   */
  _clusterUnits(fromLine) {
    const collected = [];
    let line = fromLine;
    let guard = 0;

    while (guard++ < 16) {
      const units = this._unitsForLine(line);
      if (!units) break;
      collected.push(...units);

      const next = this.scriptElements[line + 1];
      if (!next || !next.overlap || !next.overlap.mode) break;
      line++;
    }

    return collected;
  }

  _clusterReady(units) {
    return units.every(unit => !!this.kokoroEngine.getCached(unit.key));
  }

  /** Unit at the scheduling cursor, skipping over lines with nothing to say. */
  _unitAtCursor() {
    let guard = 0;
    while (guard++ < this.scriptElements.length + 2) {
      const units = this._unitsForLine(this.cursorLine);
      if (!units) return null;
      if (this.cursorUnit < units.length) return units[this.cursorUnit];
      this.cursorLine++;
      this.cursorUnit = 0;
    }
    return null;
  }

  _advanceCursor() {
    const units = this._unitsForLine(this.cursorLine);
    if (!units) return;
    this.cursorUnit++;
    if (this.cursorUnit >= units.length) {
      this.cursorLine++;
      this.cursorUnit = 0;
    }
  }

  /**
   * Ask the worker for everything within the lookahead window, tagging each
   * request with its distance from the playhead so the queue drains in the
   * order the listener will actually need it.
   */
  _pumpRequests() {
    if (!this.kokoroEngine.isReady) return;

    let line = this.cursorLine;
    let unit = this.cursorUnit;
    let seconds = 0;
    let count = 0;
    let guard = 0;

    while (count < LOOKAHEAD_UNITS && seconds < LOOKAHEAD_SEC && guard++ < 500) {
      const units = this._unitsForLine(line);
      if (!units) break;
      if (unit >= units.length) {
        line++;
        unit = 0;
        continue;
      }

      const u = units[unit];
      const cached = this.kokoroEngine.getCached(u.key);
      if (cached) {
        seconds += cached.duration / (u.playbackRate || 1);
      } else {
        this.kokoroEngine.request(u, count);
        seconds += u.estimatedDuration;
      }

      seconds += u.leadPause || 0;
      count++;
      unit++;
    }
  }

  /** Contiguous ready audio from the cursor forward, and whether we hit the end. */
  _readyRunway() {
    let line = this.cursorLine;
    let unit = this.cursorUnit;
    let seconds = 0;
    let guard = 0;

    while (guard++ < 500) {
      const units = this._unitsForLine(line);
      if (!units) return { seconds, hitEnd: true };
      if (unit >= units.length) {
        line++;
        unit = 0;
        continue;
      }

      const u = units[unit];
      const cached = this.kokoroEngine.getCached(u.key);
      if (!cached) return { seconds, hitEnd: false };

      seconds += cached.duration / (u.playbackRate || 1);
      unit++;
    }

    return { seconds, hitEnd: false };
  }

  _hasPrimeBudget() {
    const need = this.hasStartedAnyLine ? PRIME_SECONDS_RECOVER : PRIME_SECONDS_INITIAL;
    const { seconds, hitEnd } = this._readyRunway();
    if (hitEnd) return true;
    if (seconds >= need) return true;
    return Date.now() > this.primeDeadline;
  }

  _pumpScheduling() {
    let guard = 0;
    // Raised from 64 so a long cluster can never be cut in half by the guard.
    while (guard++ < 128) {
      const unit = this._unitAtCursor();
      if (!unit) {
        this.reachedEnd = true;
        break;
      }

      const midCluster = this.clusterRemaining > 0;

      // The horizon check only applies between clusters. Once a cluster starts
      // it is placed whole: scheduling a four-second line pushes bufferedAhead
      // well past the horizon, and stopping there would strand the line meant
      // to start *with* it until the playhead had almost caught up — silently
      // turning simultaneous speech back into a queue.
      if (!midCluster && this.scheduler.bufferedAhead >= SCHEDULE_AHEAD_SEC) break;

      if (!midCluster && unit.isFirstChunk) {
        const cluster = this._clusterUnits(unit.lineIndex);
        // Every voice in the cluster has to be rendered before any of it is
        // committed, or the overlap resolves against a half-built timeline.
        if (cluster.length > unit.chunkCount && !this._clusterReady(cluster)) break;
        this.clusterRemaining = cluster.length;
      }

      const buffer = this.kokoroEngine.getCached(unit.key);
      if (!buffer) break;

      if (!this.primed) {
        if (!this._hasPrimeBudget()) break;
        this.primed = true;
        // Coming out of a stall, the timeline edge is in the past — snap it to
        // now so the next line plays immediately instead of retroactively.
        if (this.scheduler.timelineEnd < this.scheduler.currentTime) {
          this.scheduler.resetTimeline();
        }
      }

      this._recordScheduled(unit, this.scheduler.schedule(unit, buffer));
      if (this.clusterRemaining > 0) this.clusterRemaining--;
      this._advanceCursor();
    }
  }

  /** Note where a scheduled unit lands, so the playhead can announce its line. */
  _recordScheduled(unit, { startAt, endAt, truncated }) {
    const line = unit.lineIndex;

    this.lineEndAt.set(line, Math.max(this.lineEndAt.get(line) || 0, endAt));
    if (unit.isLastChunk) this.lineComplete.set(line, true);
    if (truncated) this.lineTruncated.set(line, true);

    if (unit.isFirstChunk) {
      this.pendingStarts.push({
        lineIndex: line,
        startAt,
        overlapMode: unit.overlapMode || 'sequential'
      });
    }
  }

  _pumpPlayhead() {
    const clock = this.scheduler.currentTime;
    const now = clock + PLAYHEAD_LEAD_SEC;

    // --- starts. Overlap means timeline order is not start order, so gather
    // everything that is due and announce it chronologically.
    const due = [];
    const waiting = [];
    for (const entry of this.pendingStarts) {
      (entry.startAt <= now ? due : waiting).push(entry);
    }
    if (due.length > 0) {
      this.pendingStarts = waiting;
      due.sort((a, b) => a.startAt - b.startAt);
    }

    for (const entry of due) {
      const element = this.scriptElements[entry.lineIndex];
      if (!element) continue;

      const isClusterHead = this.activeLines.size === 0;

      this.activeLines.set(entry.lineIndex, element);
      this.currentIndex = entry.lineIndex;
      this.hasStartedAnyLine = true;

      this.emit('lineStart', {
        index: entry.lineIndex,
        element,
        voice: this.getVoiceProfileForCharacter(element.character),
        nuance: element.nuance || {},
        overlapMode: entry.overlapMode,
        isClusterHead,
        concurrent: this.getActiveLineIndices().filter(i => i !== entry.lineIndex)
      });

      if (this.visualizer && isClusterHead) {
        this.visualizer.setSpeaking(true, element.nuance || {});
      }
    }

    // --- ends, driven by when the audio actually stops rather than by the next
    // line starting. The completeness gate matters: a line whose later chunks
    // have not been scheduled yet has simply run out of runway, and ending it
    // there would leave its remaining audio playing with nothing highlighted.
    for (const [line, element] of Array.from(this.activeLines)) {
      if (!this.lineComplete.get(line) && !this.lineTruncated.get(line)) continue;
      const endAt = this.lineEndAt.get(line);
      if (endAt === undefined || clock < endAt) continue;

      this.activeLines.delete(line);
      this.emit('lineEnd', {
        index: line,
        element,
        truncated: !!this.lineTruncated.get(line)
      });
    }

    if (this.activeLines.size === 0 && this.visualizer) {
      this.visualizer.setSpeaking(false);
    }

    this._prunePlayhead(clock);
  }

  _prunePlayhead(clock) {
    if (this.lineEndAt.size <= 64) return;
    const cutoff = clock - PLAYHEAD_RETAIN_SEC;
    for (const [line, endAt] of Array.from(this.lineEndAt)) {
      if (endAt >= cutoff || this.activeLines.has(line)) continue;
      this.lineEndAt.delete(line);
      this.lineComplete.delete(line);
      this.lineTruncated.delete(line);
    }
  }

  /** Lines currently sounding, in script order. */
  getActiveLineIndices() {
    return Array.from(this.activeLines.keys()).sort((a, b) => a - b);
  }

  /** Distinct characters currently speaking, in script order. */
  getActiveCharacters() {
    const names = [];
    for (const index of this.getActiveLineIndices()) {
      const name = this.activeLines.get(index).character;
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  _pumpState() {
    const buffered = this.scheduler.bufferedAhead;

    if (this.reachedEnd && buffered <= 0.02) {
      this._finish();
      return;
    }

    // Draining the last scheduled line is not starvation; it is the ending.
    const starving = buffered <= 0.05 && !this.reachedEnd;

    if (starving && this.playbackState !== PLAYBACK_STATES.BUFFERING) {
      this.primed = false;
      this.primeDeadline = Date.now() + PRIME_TIMEOUT_MS;
      this._setState(PLAYBACK_STATES.BUFFERING);
      if (this.visualizer) this.visualizer.setSpeaking(false);
    } else if (!starving && this.playbackState === PLAYBACK_STATES.BUFFERING) {
      this._setState(PLAYBACK_STATES.PLAYING);
    }
  }

  _tick() {
    if (this.playbackState !== PLAYBACK_STATES.PLAYING &&
        this.playbackState !== PLAYBACK_STATES.BUFFERING) {
      return;
    }
    if (!this.scheduler || !this.scheduler.ctx) return;

    this._pumpRequests();
    this._pumpScheduling();
    this._pumpPlayhead();
    this._pumpState();
  }

  _startTick() {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => this._tick(), TICK_MS);
    this._tick();
  }

  _stopTick() {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  _finish() {
    for (const [line, element] of this.activeLines) {
      this.emit('lineEnd', {
        index: line,
        element,
        truncated: !!this.lineTruncated.get(line)
      });
    }
    this._stopTick();
    this._resetPlayheadState();
    this.currentIndex = 0;
    this.cursorLine = 0;
    this.cursorUnit = 0;
    this.reachedEnd = false;
    this.primed = false;
    if (this.visualizer) this.visualizer.setSpeaking(false);
    this._setState(PLAYBACK_STATES.IDLE);
    this.emit('complete', {});
  }

  // -------------------------------------------------------------- audio setup

  async _ensureAudio() {
    const ctx = getAudioContext();
    if (!ctx) return null;

    if (!this.scheduler) {
      this.scheduler = new PlaybackScheduler();
      this.scheduler.setVolume(this.volume);
      this.scheduler.setMuted(this.isMuted);
      if (this.visualizer) {
        this.visualizer.start(this.scheduler.getAnalyser());
      }
    }

    await resumeAudioContext();
    return this.scheduler;
  }

  /**
   * Render a few units ahead without playing, so the first Play has no wait.
   */
  prewarm() {
    if (!this.kokoroEngine.isReady || this.scriptElements.length === 0) return;
    if (this.playbackState === PLAYBACK_STATES.PLAYING) return;

    this.cursorLine = this.currentIndex;
    this.cursorUnit = 0;

    let line = this.currentIndex;
    let unit = 0;
    let count = 0;
    let guard = 0;

    while (count < 6 && guard++ < 60) {
      const units = this._unitsForLine(line);
      if (!units) break;
      if (unit >= units.length) {
        line++;
        unit = 0;
        continue;
      }
      this.kokoroEngine.request(units[unit], count);
      count++;
      unit++;
    }
  }

  // ------------------------------------------------------------- transport API

  async play() {
    if (this.scriptElements.length === 0) return;
    if (this.playbackState === PLAYBACK_STATES.PLAYING ||
        this.playbackState === PLAYBACK_STATES.BUFFERING) {
      return;
    }

    const generation = ++this.playGeneration;

    await this._ensureAudio();
    if (generation !== this.playGeneration) return;

    // Resuming from pause: the context clock was frozen, so everything already
    // scheduled is still valid and simply continues.
    if (this.playbackState === PLAYBACK_STATES.PAUSED && !this.usingWebSpeechFallback) {
      this._setState(PLAYBACK_STATES.PLAYING);
      this._startTick();
      return;
    }

    if (!this.kokoroEngine.isReady && !this.kokoroEngine.isLoading) {
      try {
        await this.kokoroEngine.init();
      } catch (err) {
        console.warn('Kokoro unavailable, falling back to browser speech:', err);
      }
      if (generation !== this.playGeneration) return;
    }

    if (!this.kokoroEngine.isReady && !this.kokoroEngine.isLoading) {
      this.usingWebSpeechFallback = true;
      this._setState(PLAYBACK_STATES.PLAYING);
      this._runWebSpeech();
      return;
    }

    this.usingWebSpeechFallback = false;
    this._beginNeuralPlayback(this.currentIndex);
  }

  _beginNeuralPlayback(fromIndex) {
    if (!this.scheduler) return;

    this.scheduler.stopAll();
    this.scheduler.resetTimeline(this.scheduler.currentTime + 0.08);

    this._resetPlayheadState();
    this.reachedEnd = false;
    this.primed = false;
    this.primeDeadline = Date.now() + PRIME_TIMEOUT_MS;

    this.cursorLine = Math.max(0, Math.min(this.scriptElements.length - 1, fromIndex));
    this.cursorUnit = 0;
    this.currentIndex = this.cursorLine;

    this._setState(PLAYBACK_STATES.BUFFERING);
    this._startTick();
  }

  async pause() {
    if (this.playbackState !== PLAYBACK_STATES.PLAYING &&
        this.playbackState !== PLAYBACK_STATES.BUFFERING) {
      return;
    }

    this._stopTick();
    this._setState(PLAYBACK_STATES.PAUSED);

    if (this.visualizer) this.visualizer.setSpeaking(false);

    if (this.usingWebSpeechFallback) {
      this.webSpeechToken++;
      if (this._webSpeechTimer) clearTimeout(this._webSpeechTimer);
      this.webSpeechEngine.stop();
      return;
    }

    // Freezing the context clock holds every scheduled source in place, so
    // resuming picks up mid-line with no re-render.
    await suspendAudioContext();
  }

  stop() {
    this.playGeneration++;
    this.previewToken++;
    if (this._previewResolve) {
      const resolve = this._previewResolve;
      this._previewResolve = null;
      resolve();
    }

    this.webSpeechToken++;
    if (this._webSpeechTimer) {
      clearTimeout(this._webSpeechTimer);
      this._webSpeechTimer = null;
    }
    this.webSpeechEngine.stop();

    this._stopTick();

    if (this.scheduler) {
      this.scheduler.stopAll();
    }

    this._resetPlayheadState();
    this.reachedEnd = false;
    this.primed = false;

    if (this.visualizer) this.visualizer.setSpeaking(false);

    this._setState(PLAYBACK_STATES.IDLE);
  }

  seek(index) {
    const target = Math.max(0, Math.min(this.scriptElements.length - 1, index));
    const wasPlaying = this.playbackState === PLAYBACK_STATES.PLAYING ||
                       this.playbackState === PLAYBACK_STATES.BUFFERING;

    this.stop();
    this.currentIndex = target;
    this.cursorLine = target;
    this.cursorUnit = 0;

    // Abandon lookahead the jump made irrelevant, keeping only what we now need.
    this.kokoroEngine.dropPendingExcept(this._upcomingKeys(target, 8));

    this.emit('lineChange', {
      index: this.currentIndex,
      element: this.scriptElements[this.currentIndex]
    });

    if (wasPlaying) {
      this.play();
    } else {
      this.prewarm();
    }
  }

  _upcomingKeys(fromLine, count) {
    const keys = [];
    let line = fromLine;
    let unit = 0;
    let guard = 0;

    while (keys.length < count && guard++ < 60) {
      const units = this._unitsForLine(line);
      if (!units) break;
      if (unit >= units.length) {
        line++;
        unit = 0;
        continue;
      }
      keys.push(units[unit].key);
      unit++;
    }
    return keys;
  }

  skipNext() {
    if (this.currentIndex < this.scriptElements.length - 1) {
      this.seek(this.currentIndex + 1);
    }
  }

  skipPrev() {
    if (this.currentIndex > 0) {
      this.seek(this.currentIndex - 1);
    }
  }

  _restartIfPlaying() {
    if (this.playbackState === PLAYBACK_STATES.PLAYING ||
        this.playbackState === PLAYBACK_STATES.BUFFERING) {
      this.seek(this.currentIndex);
    }
  }

  // ------------------------------------------------------------------ previews

  /**
   * Audition a voice in the Cast Studio. Resolves when playback actually ends,
   * so the calling UI can flip its button back at the right moment.
   */
  async previewVoice(voiceId, sampleText = null, pitchOffset = 0, speedMultiplier = 1.0) {
    this.stop();

    const token = ++this.previewToken;
    const profile = getVoiceById(voiceId);
    const text = sampleText || profile.sampleLine;

    await this._ensureAudio();

    if (!this.kokoroEngine.isReady && !this.kokoroEngine.isLoading) {
      try {
        await this.kokoroEngine.init();
      } catch (err) {
        console.warn('Kokoro init fallback for preview:', err);
      }
    }
    if (token !== this.previewToken) return;

    if (this.visualizer) {
      this.visualizer.setSpeaking(true, { badgeColor: '#F59E0B' });
    }

    if (this.kokoroEngine.isReady && this.scheduler) {
      try {
        const units = buildPreviewUnits({
          text,
          voiceProfile: profile,
          tuning: { pitchOffset, speedMultiplier },
          masterSpeed: this.masterSpeed
        });

        const buffers = [];
        for (let i = 0; i < units.length; i++) {
          buffers.push(await this.kokoroEngine.request(units[i], i));
          if (token !== this.previewToken) return;
        }

        this.scheduler.resetTimeline(this.scheduler.currentTime + 0.06);
        let endAt = this.scheduler.currentTime;
        units.forEach((unit, i) => {
          endAt = this.scheduler.schedule(unit, buffers[i]).endAt;
        });

        await this._waitUntil(endAt + 0.05, token);
        if (token === this.previewToken && this.visualizer) {
          this.visualizer.setSpeaking(false);
        }
        return;
      } catch (err) {
        console.warn('Kokoro preview failed, falling back to browser speech:', err);
        if (token !== this.previewToken) return;
      }
    }

    await new Promise((resolve) => {
      this._previewResolve = resolve;
      this.webSpeechEngine.speakLine({
        text,
        voiceProfile: profile,
        nuance: { cleanSpeech: text },
        speedMultiplier: speedMultiplier * this.masterSpeed,
        onEnd: () => {
          this._previewResolve = null;
          if (this.visualizer) this.visualizer.setSpeaking(false);
          resolve();
        },
        onError: () => {
          this._previewResolve = null;
          if (this.visualizer) this.visualizer.setSpeaking(false);
          resolve();
        }
      });
    });
  }

  /** Wait for the audio clock to reach `time`, interruptible by stop(). */
  _waitUntil(time, token) {
    return new Promise((resolve) => {
      this._previewResolve = resolve;

      const check = () => {
        if (token !== this.previewToken) {
          this._previewResolve = null;
          resolve();
          return;
        }
        const remaining = time - this.scheduler.currentTime;
        if (remaining <= 0) {
          this._previewResolve = null;
          resolve();
          return;
        }
        setTimeout(check, Math.min(250, Math.max(30, remaining * 1000)));
      };

      check();
    });
  }

  // ------------------------------------------------------ web speech fallback

  _runWebSpeech() {
    const token = ++this.webSpeechToken;

    const step = () => {
      if (token !== this.webSpeechToken) return;
      if (this.playbackState !== PLAYBACK_STATES.PLAYING) return;

      if (this.currentIndex >= this.scriptElements.length) {
        this._finish();
        return;
      }

      const element = this.scriptElements[this.currentIndex];
      const voice = this.getVoiceProfileForCharacter(element.character);
      const nuance = element.nuance || {};
      const tuning = this.getCharacterSettings(element.character);

      // The fallback engine is strictly one voice at a time, so the active set
      // never holds more than a single line here.
      this.activeLines.clear();
      this.activeLines.set(this.currentIndex, element);
      this.hasStartedAnyLine = true;
      this.emit('lineStart', {
        index: this.currentIndex,
        element,
        voice,
        nuance,
        overlapMode: 'sequential',
        isClusterHead: true,
        concurrent: []
      });
      if (this.visualizer) this.visualizer.setSpeaking(true, nuance);

      const advance = () => {
        if (token !== this.webSpeechToken) return;
        if (this.playbackState !== PLAYBACK_STATES.PLAYING) return;

        this.activeLines.delete(this.currentIndex);
        this.emit('lineEnd', { index: this.currentIndex, element, truncated: false });

        const next = this.scriptElements[this.currentIndex + 1];
        const gap = next ? computeCueGapMs(element, next, this.pacingMode, this.masterSpeed) : 0;
        this.currentIndex++;
        this._webSpeechTimer = setTimeout(step, gap);
      };

      if (!nuance.cleanSpeech && !element.text) {
        advance();
        return;
      }

      this.webSpeechEngine.speakLine({
        text: element.text,
        voiceProfile: voice,
        nuance,
        speedMultiplier: (tuning.speedMultiplier || 1) * this.masterSpeed * (nuance.speedMod || 1),
        onEnd: advance,
        onError: advance
      });
    };

    step();
  }
}

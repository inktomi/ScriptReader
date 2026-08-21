import { hasRunPodKey, loadEngineSettings, saveEngineSettings } from '../utils/credentials.js';
import { getAudioContext, resumeAudioContext, suspendAudioContext } from './audio-context.js';
import { ChatterboxStudioEngine, getChatterboxCacheStatus } from './chatterbox-engine.js';
import { MAX_RENDER_CACHE_SECONDS } from './chatterbox-render-store.js';
import { ENGINE_IDS } from './engine-contract.js';
import { runExportJob } from './export-job.js';
import { KokoroNeuralEngine } from './kokoro-engine.js';
import { DEFAULT_MODEL_ID, ModelCacheManager } from './model-cache-manager.js';
import { OpenAiTtsEngine } from './openai-engine.js';
import { buildLineUnits, buildPreviewUnits, computeCueGapMs } from './performance-director.js';
import { PlaybackScheduler } from './playback-scheduler.js';
import { RunPodServerlessEngine } from './runpod-engine.js';
import { DEFAULT_NARRATOR_VOICE_ID, getVoiceById, getVoicesForEngine, mapVoiceAcrossEngines } from './voice-catalog.js';
import { WebSpeechEngine } from './web-speech-engine.js';

/**
 * Retained so existing imports keep resolving; `ENGINE_IDS` in engine-contract.js
 * is the real registry now.
 */
export const ENGINE_TYPES = {
  KOKORO_NEURAL: ENGINE_IDS.KOKORO,
  CHATTERBOX: ENGINE_IDS.CHATTERBOX,
  RUNPOD: ENGINE_IDS.RUNPOD,
  OPENAI: ENGINE_IDS.OPENAI,
  WEB_SPEECH: ENGINE_IDS.WEB_SPEECH,
};

export const PLAYBACK_STATES = {
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
  BUFFERING: 'buffering',
};

export const PACING_MODES = {
  NATURAL: 'natural', // Authentic human table read
  DRAMATIC: 'dramatic', // Rich theatrical breathing and tension
  SNAPPY: 'snappy', // Rapid rehearsal readthrough
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

// Studio renders continuously into a persistent, bounded cache. Only a small
// batch is admitted to the worker at once because every queued Chatterbox unit
// carries a transferable copy of its reference recording.
const STUDIO_PREWARM_UNITS = 10000;
const STUDIO_PREWARM_BATCH_UNITS = 6;
const STUDIO_CACHE_DURATION_BUDGET = MAX_RENDER_CACHE_SECONDS * 0.8;
const STUDIO_MIN_RUNWAY_SECONDS = 5 * 60;
const STUDIO_RENDER_SAFETY_FACTOR = 0.8;
const STUDIO_UNKNOWN_RENDER_RATE = 0;
const DEFAULT_PREWARM_UNITS = 6;

// Audio banked before the first line plays, versus after recovering a stall.
// Starting with a cushion is what turns "press play, hear a stutter" into
// "press play, sit back".
const PRIME_SECONDS_INITIAL = 3.0;
const PRIME_SECONDS_RECOVER = 1.5;
const PRIME_TIMEOUT_MS = 20000;

// How long buffering may make no progress at all before it is reported as a
// failure. Generous, because a cold local engine really can take this long to
// produce its first line — but finite, because the alternative is a spinner
// that never resolves and says nothing about why.
const STALL_TIMEOUT_MS = 45000;

// Highlight the line a beat before its audio, so the teleprompter never lags.
const PLAYHEAD_LEAD_SEC = 0.02;

// How far apart the cast is seated. Wide enough that two simultaneous voices
// separate cleanly, narrow enough that nobody sounds like they left the room.
const PAN_SPREAD = 0.35;

// Playhead entries are kept this long past their end before being pruned.
const PLAYHEAD_RETAIN_SEC = 5;

// What the export row says while each stage runs.
const EXPORT_PHASE_MESSAGES = {
  preparing: 'Preparing the export',
  rendering: 'Rendering the read',
  encoding: 'Finishing the audio',
  saving: 'Saving the file',
};

export class ScreenplayAudioManager {
  constructor() {
    this.webSpeechEngine = new WebSpeechEngine();
    this.modelCacheManager = ModelCacheManager;

    // Constructed eagerly but inert until init(): the OpenAI engine holds nothing
    // but a key lookup, and Kokoro does not touch the network until asked.
    this._engines = new Map([
      [ENGINE_IDS.KOKORO, new KokoroNeuralEngine()],
      [ENGINE_IDS.CHATTERBOX, new ChatterboxStudioEngine()],
      [ENGINE_IDS.RUNPOD, new RunPodServerlessEngine()],
      [ENGINE_IDS.OPENAI, new OpenAiTtsEngine()],
    ]);

    const saved = loadEngineSettings();
    this.engineId = this._engines.has(saved.engineId) ? saved.engineId : ENGINE_IDS.KOKORO;
    this.hybridCasting = saved.hybridCasting !== undefined ? !!saved.hybridCasting : true;
    this.engine = this._engines.get(this.engineId);

    this._progressListeners = new Set();
    this._unbindProgress = null;
    this._bindEngineProgress();

    this.scheduler = null;

    this.scriptElements = [];
    this.characterAssignments = new Map();
    this.narratorVoiceId = DEFAULT_NARRATOR_VOICE_ID;

    this.currentIndex = 0;
    this.playbackState = PLAYBACK_STATES.IDLE;
    this.pacingMode = PACING_MODES.NATURAL;
    this.masterSpeed = 1.0;
    this.volume = 1.0;
    this.isMuted = false;

    this.visualizer = null;
    this.listeners = new Set();

    // Render pipeline state
    this.unitCache = new Map(); // lineIndex -> unit[]
    this.cursorLine = 0; // next line to schedule
    this.cursorUnit = 0; // next chunk within that line
    this.stageOrder = []; // speaking characters, most lines first — drives panning

    // Playhead bookkeeping. Overlapping speech means more than one line can be
    // sounding at once, so "the active line" is a set, and a line ends when its
    // own audio ends — not when some other line happens to start.
    this.pendingStarts = []; // [{ lineIndex, startAt, overlapMode }] not yet announced
    this.lineEndAt = new Map(); // lineIndex -> latest effective end time
    this.lineComplete = new Map(); // lineIndex -> its last chunk has been scheduled
    this.lineTruncated = new Map(); // lineIndex -> it was cut off by an interrupter
    this.activeLines = new Map(); // lineIndex -> element, currently sounding
    this.hasStartedAnyLine = false;
    this.clusterRemaining = 0; // units left to place in the cluster being scheduled

    this.reachedEnd = false;
    this.primed = false;
    this.primeDeadline = 0;
    // Zero means "not buffering, nothing to watch". Set whenever the pipeline
    // starves, cleared as soon as it recovers.
    this.stallDeadline = 0;
    // Engines the render pump has already tried to start during this run.
    this._autoInitAttempted = new Set();
    this.tickHandle = null;

    // Bumped by every stop/seek/play. `play()` has to await engine init and the
    // audio context, and a seek arriving during those awaits must not leave two
    // start-ups racing to schedule from different cursors.
    this.playGeneration = 0;

    // Separates background renders built from different casts, pacing, or
    // engine-native voices even when playback itself has not moved.
    this.prewarmGeneration = 0;
    this._preparedStudioKeys = new Set();
    const isStudioEngine = this.engineId === ENGINE_IDS.CHATTERBOX || this.engineId === ENGINE_IDS.RUNPOD;
    this.renderStatus = {
      visible: isStudioEngine,
      active: false,
      canPlay: !isStudioEngine,
      engineLabel: this.engine?.capabilities?.label || 'Studio',
      completed: 0,
      total: 0,
      percent: 0,
      etaSeconds: null,
      message: '',
    };

    // One export at a time, owned by a generation counter for the same reason
    // the prewarm has one: a cast edit mid-export invalidates the units the
    // remaining clusters were going to be built from.
    this.exportGeneration = 0;
    this._exportAbort = null;
    this.exportStatus = {
      active: false,
      phase: 'idle',
      completed: 0,
      total: 0,
      percent: 0,
      renderedSeconds: 0,
      etaSeconds: null,
      error: null,
      message: '',
    };

    this.previewToken = 0;
    this._previewResolve = null;
    this.webSpeechToken = 0;
    this._webSpeechTimer = null;
    this.usingWebSpeechFallback = false;
  }

  /**
   * The Kokoro instance specifically — *not* "whichever engine is active".
   *
   * The HF model hub and the download toast are about model *weights*: a cache
   * badge, a byte-progress bar, a retry button. Pointing those at the active
   * engine would make the hub's Retry button initialise OpenAI, which has no
   * weights to retry. This accessor is the correct shape for those callers and
   * stays after the migration.
   */
  get kokoroEngine() {
    return this._engines.get(ENGINE_IDS.KOKORO);
  }

  getEngine(engineId) {
    return this._engines.get(engineId) || null;
  }

  async prepareEngine(engineId) {
    const engine = this._engines.get(engineId);
    if (!engine) throw new Error('Unknown voice engine.');
    await engine.init();
    return engine;
  }

  async getChatterboxCacheStatus() {
    return getChatterboxCacheStatus();
  }

  get capabilities() {
    return this.engine.capabilities;
  }

  /**
   * Subscribe to progress from whichever engine is active. Indirected through the
   * manager because a direct `engine.onProgress` subscription would stay bound to
   * whichever engine existed at boot and go silent after a switch.
   */
  onEngineProgress(callback) {
    this._progressListeners.add(callback);
    return () => this._progressListeners.delete(callback);
  }

  _bindEngineProgress() {
    if (this._unbindProgress) this._unbindProgress();
    this._unbindProgress = this.engine.onProgress((payload) => {
      for (const cb of this._progressListeners) {
        try {
          cb({ ...payload, engineId: this.engineId });
        } catch (err) {
          console.error('Engine progress subscriber error:', err);
        }
      }

      if (payload.phase === 'error' && this.playbackState !== PLAYBACK_STATES.IDLE) {
        const error = this.engine.lastError;
        const message = payload.message || (error && error.message) || 'Voice synthesis failed.';
        const code = (error && error.code) || 'runtime_failure';
        const canFallback = this.engine.capabilities.onUnavailable === 'webspeech';

        this.stop();
        if (canFallback) {
          this.usingWebSpeechFallback = true;
          this._setState(PLAYBACK_STATES.PLAYING);
          this._runWebSpeech();
        } else {
          this.emit('engineError', { engineId: this.engineId, code, message });
        }
      }
    });
  }

  async init() {
    await this.webSpeechEngine.init();
    // Only warm the neural weights when they are what will actually be used.
    // Pulling a few hundred megabytes in the background for a listener who has
    // chosen cloud voices is a wait they never benefit from.
    if (this.engineId === ENGINE_IDS.KOKORO) {
      this.engine.init().catch((err) => {
        console.warn('Kokoro background preload notice:', err);
      });
      return;
    }

    if (this.engineId === ENGINE_IDS.RUNPOD) {
      if (hasRunPodKey() || this.engine.getApiKey?.()?.trim()) {
        const engine = this.engine;
        const generation = this.playGeneration;
        engine
          .init()
          .then(() => {
            if (
              generation === this.playGeneration &&
              this.engineId === ENGINE_IDS.RUNPOD &&
              this.engine === engine &&
              engine.isReady
            ) {
              this.prewarm();
            }
          })
          .catch((err) => {
            console.warn('RunPod background preload notice:', err);
          });
      }
      return;
    }

    // Studio Local is warmed only when its weights are already on the device.
    // Loading something local costs nothing the listener has not already paid
    // for; beginning a 1.4 GB download at boot for someone who never asked is a
    // different proposition, so an uninstalled engine waits for an explicit
    // install or the first Play.
    if (this.engineId === ENGINE_IDS.CHATTERBOX) {
      // Hybrid casting speaks the narration through Kokoro, so under Studio
      // Local it is not a second engine the listener might one day pick — it is
      // half of what is about to play. Warming only Chatterbox here is what let
      // a script reach "100% pre-rendered" with every action line unrenderable.
      if (this.hybridCasting) {
        this.kokoroEngine.init().catch((err) => {
          console.warn('Kokoro narration preload notice:', err);
        });
      }

      const engine = this.engine;
      const generation = this.playGeneration;
      getChatterboxCacheStatus()
        .then((status) => {
          if (
            !status.installed ||
            generation !== this.playGeneration ||
            this.engineId !== ENGINE_IDS.CHATTERBOX ||
            this.engine !== engine
          ) {
            return null;
          }
          return engine.init();
        })
        .then(() => {
          if (
            generation === this.playGeneration &&
            this.engineId === ENGINE_IDS.CHATTERBOX &&
            this.engine === engine &&
            engine.isReady
          ) {
            this.prewarm();
          }
        })
        .catch((err) => {
          console.warn('Studio Local background preload notice:', err);
        });
    }
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

  /**
   * Switch synthesis engines.
   *
   * `_invalidateUnits()` is mandatory here, not defensive. Every cache key carries
   * the engine id, the engine-native voice id, and a hash of the instruction text,
   * so memoised units from the previous engine reference keys the new one will
   * never populate — scheduling would simply wait forever for audio that is not
   * coming. The old `setEngineType` omitted this, which is why it could never
   * safely have been called.
   */
  setEngine(engineId) {
    if (!this._engines.has(engineId) || engineId === this.engineId) return;

    const previousEngine = this.engine;
    this.stop();
    // Chatterbox is a multi-session model of roughly 1.5 GB. Keep its files on
    // disk, but release the worker and GPU allocations when the listener moves
    // to another engine. Returning to Studio Local reloads from the browser
    // cache instead of keeping both neural stacks resident in memory.
    previousEngine.release?.();
    this.engineId = engineId;
    this.engine = this._engines.get(engineId);
    this._ensureEngineVoices();
    this._invalidateUnits();
    this._bindEngineProgress();
    this.usingWebSpeechFallback = false;
    saveEngineSettings({ engineId });

    this.emit('engineChange', { engineId, capabilities: this.engine.capabilities });

    if (this.engineId === ENGINE_IDS.RUNPOD) {
      if (!this.engine.isReady && (hasRunPodKey() || this.engine.getApiKey?.()?.trim())) {
        this.engine
          .init()
          .then(() => {
            if (this.engineId === ENGINE_IDS.RUNPOD) this.prewarm();
          })
          .catch((err) => {
            console.warn('RunPod setEngine init notice:', err);
          });
      }
    }

    this.prewarm();
  }

  /** @deprecated Use setEngine(). Kept so older callers keep working. */
  setEngineType(engineType) {
    this.setEngine(engineType);
  }

  setScript(elements, characterMap = new Map(), startIndex = 0) {
    const replacingRunPodScript = this.engineId === ENGINE_IDS.RUNPOD && this.scriptElements.length > 0;
    this.stop();
    if (replacingRunPodScript) {
      // The browser's durable render store remains available for resume, but
      // requests, decoded buffers, and private reference encodings belong only
      // to the script that created them.
      this.engine.release?.();
    }
    // The persistent store may have evicted records belonging to the previous
    // script. Re-probe through engine.request(); cache hits are cheap and this
    // prevents an in-memory key set from overstating what is still durable.
    this._preparedStudioKeys.clear();
    this.scriptElements = elements || [];
    this.characterAssignments = characterMap;
    this.currentIndex = Math.max(0, Math.min(this.scriptElements.length - 1, startIndex || 0));
    this._buildStageOrder();
    this._ensureEngineVoices();
    this._invalidateUnits();
    this.emit('scriptLoaded', {
      totalLines: this.scriptElements.length,
      currentIndex: this.currentIndex,
    });
    this.prewarm();
  }

  setVoiceAssignment(characterName, assignment) {
    this.characterAssignments.set(characterName.toUpperCase().trim(), assignment);
    this._ensureEngineVoices();
    this._dropPendingExcept([]);
    this._invalidateUnits();
    this.prewarm();
  }

  setCastAssignments(assignmentsMap) {
    if (!assignmentsMap) return;
    const entries = assignmentsMap instanceof Map ? assignmentsMap.entries() : Object.entries(assignmentsMap);
    for (const [charKey, assignment] of entries) {
      this.characterAssignments.set(charKey.toUpperCase().trim(), assignment);
    }
    this._ensureEngineVoices();
    this._dropPendingExcept([]);
    this._invalidateUnits();
    this.prewarm();
  }

  /**
   * Give every character a voice the *active* engine can actually speak with.
   *
   * A cast is recorded per engine, because the two voice-id spaces are disjoint
   * and neither is a translation of the other. Without this step a Kokoro cast
   * viewed under OpenAI resolves every single character to the first voice in the
   * pool — the whole cast collapsing to one voice, silently, because
   * `getVoiceById` has to return *something*.
   *
   * Seeded ids are persisted onto the assignment objects the store owns, so the
   * mapping is decided once and stays stable rather than being re-derived (and
   * possibly re-shuffled) on every render.
   */
  /**
   * The narrator voice translated into the active engine's pool. Stored so the
   * choice is stable across renders, and reserved before the cast is seeded so no
   * character is handed the narrator's voice.
   */
  _narratorVoiceForEngine(targetEngineId = this.engineId) {
    const engineId = targetEngineId || this.engineId;
    const saved = this.narratorVoiceId || DEFAULT_NARRATOR_VOICE_ID;
    if (getVoicesForEngine(engineId).some((v) => v.id === saved)) return saved;

    if (!this._narratorByEngine) this._narratorByEngine = {};
    if (!this._narratorByEngine[engineId]) {
      this._narratorByEngine[engineId] = mapVoiceAcrossEngines(saved, engineId);
    }
    return this._narratorByEngine[engineId];
  }

  _ensureEngineVoices() {
    if (this.characterAssignments.size === 0) return;

    const narrator = this._narratorVoiceForEngine();
    const used = new Set();

    // Reserve what is already correct for this engine before filling gaps, so
    // seeding can never hand out a voice another character already holds.
    for (const assignment of this.characterAssignments.values()) {
      const existing = assignment.voiceIds && assignment.voiceIds[this.engineId];
      if (existing) used.add(existing);
    }
    if (getVoicesForEngine(this.engineId).some((v) => v.id === narrator)) used.add(narrator);

    // Stage order is biggest-part-first, so leads are mapped before bit parts and
    // get first refusal on their preferred counterpart voice.
    const order = [
      ...this.stageOrder.filter((name) => this.characterAssignments.has(name)),
      ...[...this.characterAssignments.keys()].filter((name) => !this.stageOrder.includes(name)),
    ];

    for (const name of order) {
      const assignment = this.characterAssignments.get(name);
      if (!assignment) continue;
      if (!assignment.voiceIds) assignment.voiceIds = {};

      if (assignment.voiceIds[this.engineId]) continue;

      // The legacy single-engine field is always a Kokoro id; treat it as this
      // character's Kokoro casting rather than reinterpreting it under whichever
      // engine happens to be active.
      if (!assignment.voiceIds[ENGINE_IDS.KOKORO] && assignment.voiceId) {
        assignment.voiceIds[ENGINE_IDS.KOKORO] = assignment.voiceId;
      }

      const source = assignment.voiceIds[ENGINE_IDS.KOKORO] || assignment.voiceId;
      const mapped = mapVoiceAcrossEngines(source, this.engineId, used);
      assignment.voiceIds[this.engineId] = mapped;
      used.add(mapped);
    }
  }

  setNarratorVoice(voiceId) {
    if (this.narratorVoiceId === voiceId) return;
    this._dropPendingExcept([]);
    this.narratorVoiceId = voiceId;
    // Drop the cached cross-engine translation; it was derived from the old id.
    this._narratorByEngine = {};
    this._invalidateUnits();
    this.prewarm();
  }

  setHybridCasting(enabled) {
    this.hybridCasting = !!enabled;
    saveEngineSettings({ hybridCasting: this.hybridCasting });
    this._invalidateUnits();
    this.prewarm();
  }

  _engineForElement(element) {
    if (!element) return this.engine;
    if (this.engineId === ENGINE_IDS.CHATTERBOX && this.hybridCasting) {
      if (element.type !== 'DIALOGUE' || this._isNarratorName(element.character)) {
        return this._engines.get(ENGINE_IDS.KOKORO) || this.engine;
      }
      const cleanName = (element.character || '').toUpperCase().trim();
      const assignment = this.characterAssignments.get(cleanName);
      if (assignment?.engineId && this._engines.has(assignment.engineId)) {
        return this._engines.get(assignment.engineId);
      }
    }
    return this.engine;
  }

  _engineForUnit(unit) {
    // `this.engine` is authoritative for its own id. Looking the active id back
    // up in the registry would resolve to a different instance whenever the two
    // are not the same object, and readiness lives on the instance — so the
    // pumps would then be waiting on an engine nothing is loading.
    if (unit?.engineId && unit.engineId !== this.engine.capabilities.id && this._engines.has(unit.engineId)) {
      return this._engines.get(unit.engineId);
    }
    return this.engine;
  }

  /**
   * Every engine the loaded script will actually pull audio from.
   *
   * Hybrid casting routes narration and non-dialogue to a second engine while a
   * third can arrive through a per-character assignment, so "the engine" is not
   * enough to decide what has to be loaded. Reads through the memoised
   * `_unitsForLine` rather than re-deriving the routing, so this cannot drift
   * from what the render pumps will ask for.
   */
  _requiredEngines() {
    // The active engine is always in the set: `play()` gates on its readiness
    // and reads its capabilities to decide what an outage means, even on a
    // script where hybrid casting hands every line to somebody else.
    const engines = new Set([this.engine]);
    for (let line = 0; line < this.scriptElements.length; line++) {
      for (const unit of this._unitsForLine(line) || []) {
        engines.add(this._engineForUnit(unit));
      }
    }
    return [...engines];
  }

  /**
   * Discard queued lookahead across every engine in the cast.
   *
   * Under hybrid casting, narration and cast members are routed to secondary
   * engines while Chatterbox or another engine stays active. Flushing only
   * `this.engine` leaves the other engines synthesising abandoned lookahead
   * after a seek, a stop, or a casting change.
   */
  _dropPendingExcept(keepKeys = []) {
    for (const engine of this._requiredEngines()) {
      if (typeof engine?.dropPendingExcept === 'function') {
        engine.dropPendingExcept(keepKeys);
      }
    }
  }

  /**
   * A cast member's engine failing is not the same as *the* engine failing: the
   * rest of the cast is ready, and the listener has a one-click way out. Name
   * whichever characters are stranded so the message is about the reading rather
   * than about an engine id.
   */
  _charactersOnEngine(engine) {
    const names = [];
    for (let line = 0; line < this.scriptElements.length; line++) {
      const element = this.scriptElements[line];
      if (!element) continue;
      const units = this._unitsForLine(line) || [];
      if (!units.some((unit) => this._engineForUnit(unit) === engine)) continue;

      const name =
        element.type !== 'DIALOGUE' ? 'the narration' : (element.characterOriginal || element.character || '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  /** Required engines that are not loaded yet. Empty means nothing to await. */
  _coldEngines() {
    return this._requiredEngines().filter((engine) => !engine.isReady);
  }

  /**
   * Load every engine the script needs, in parallel.
   *
   * The two kinds of failure are reported separately rather than thrown,
   * because they mean different things: the primary engine falling over is
   * answered by `capabilities.onUnavailable`, while a supporting engine only
   * strands part of the cast and has a one-click way out.
   *
   * @returns {Promise<{primaryError: Error|null, failed: object[]}>}
   */
  async _initRequiredEngines() {
    let primaryError = null;
    const failed = [];

    await Promise.all(
      this._requiredEngines().map(async (engine) => {
        if (engine.isReady) return;
        try {
          await engine.init();
        } catch (err) {
          if (engine === this.engine) {
            primaryError = err;
            console.warn(`Engine ${this.engineId} unavailable:`, err);
          } else {
            console.warn(`Supporting engine ${engine.capabilities.id} unavailable:`, err);
          }
        }
        if (!engine.isReady && engine !== this.engine) failed.push(engine);
      }),
    );

    return { primaryError, failed };
  }

  /**
   * A supporting engine could not load. Say which part of the reading is
   * stranded, and — when the split is one the listener never asked for — offer
   * the single setting that removes it, so the answer is not "go and find the
   * right toggle in Voice Engine settings".
   */
  _emitSupportingEngineError(engine) {
    const cast = this._charactersOnEngine(engine);
    const who =
      cast.length === 0
        ? 'part of the cast'
        : cast.length <= 2
          ? cast.join(' and ')
          : `${cast.slice(0, 2).join(', ')} and ${cast.length - 2} more`;
    const label = engine.capabilities.label || engine.capabilities.id;
    const error = engine.lastError;

    this.emit('engineError', {
      engineId: engine.capabilities.id,
      code: (error && error.code) || 'supporting_unavailable',
      action: this.hybridCasting ? 'disableHybridCasting' : null,
      message: `${label} could not load for ${who}.${error && error.message ? ` ${error.message}` : ''}`,
    });
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

  getVoiceProfileForCharacter(characterName, targetEngineId = this.engineId) {
    const engineId = targetEngineId || this.engineId;
    const cleanName = (characterName || '').toUpperCase().trim();
    if (this._isNarratorName(cleanName)) {
      return getVoiceById(this._narratorVoiceForEngine(engineId), engineId);
    }

    const assignment = this.characterAssignments.get(cleanName);
    if (assignment) {
      // Assignments carry one voice per engine, so switching engines keeps each
      // character's casting on both sides rather than overwriting one with the
      // other. `voiceId` is the legacy single-engine field.
      const perEngine = assignment.voiceIds && assignment.voiceIds[engineId];
      const chosen = perEngine || (engineId === ENGINE_IDS.KOKORO ? assignment.voiceId : '');
      if (chosen) return getVoiceById(chosen, engineId);
    }
    // Reached whenever a line's speaker has no assignment — a character the
    // parser found late, or a cast that failed to load. It used to hand back the
    // worst-graded voice in the set.
    return getVoiceById('', engineId);
  }

  getCharacterSettings(characterName) {
    const cleanName = (characterName || '').toUpperCase().trim();
    const assignment = this.characterAssignments.get(cleanName);
    return {
      pitchOffset: assignment ? assignment.pitchOffset || 0 : 0,
      speedMultiplier: assignment ? assignment.speedMultiplier || 1.0 : 1.0,
      // Free-text direction for this character. Only instruction-following
      // engines read it; Kokoro ignores it, and because it feeds the cache key
      // only through the composed instructions, writing one changes nothing at
      // all on the local engine.
      direction: assignment ? assignment.direction || '' : '',
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
    return cleanName === 'NARRATOR' || cleanName === 'THE NARRATOR' || cleanName === 'STAGE';
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
    return sign * PAN_SPREAD * (1 - (tier % 3) * 0.3);
  }

  // ----------------------------------------------------------- render pipeline

  _invalidateUnits() {
    this.unitCache.clear();
    this.prewarmGeneration++;
    // Everything past the current cluster would be built from units that no
    // longer describe this cast, so the file would change voice halfway down.
    this.cancelExport('The cast or pacing changed, so the export was stopped.');
    const isStudioEngine = this.engineId === ENGINE_IDS.CHATTERBOX || this.engineId === ENGINE_IDS.RUNPOD;
    if (isStudioEngine) {
      const label = this.engine?.capabilities?.label || 'Studio';
      this._setRenderStatus({
        visible: true,
        active: this.scriptElements.length > 0,
        canPlay: false,
        engineLabel: label,
        completed: 0,
        total: 0,
        percent: 0,
        etaSeconds: null,
        error: null,
        message: this.scriptElements.length > 0 ? `Preparing ${label} audio` : '',
      });
    } else if (this.renderStatus?.visible) {
      this._setRenderStatus({ visible: false, active: false, canPlay: true, error: null, message: '' });
    }
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
    const engine = this._engineForElement(element);
    const units = buildLineUnits({
      element,
      prevElement: lineIndex > 0 ? this.scriptElements[lineIndex - 1] : null,
      lineIndex,
      voiceProfile: this.getVoiceProfileForCharacter(element.character, engine.capabilities.id),
      tuning: this.getCharacterSettings(element.character),
      pan: this.getPanForCharacter(element.character),
      masterSpeed: this.masterSpeed,
      pacing: this.pacingMode,
      engine,
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
    return this._clusterSpan(fromLine).units;
  }

  /**
   * As `_clusterUnits`, but also reporting the last line the cluster consumed.
   *
   * The exporter walks the script cluster by cluster and has to know where to
   * resume; the render pumps only ever need the units.
   */
  _clusterSpan(fromLine) {
    const collected = [];
    let line = fromLine;
    let endLine = fromLine;
    let guard = 0;

    while (guard++ < this.scriptElements.length + 1) {
      const units = this._unitsForLine(line);
      if (!units) break;
      collected.push(...units);
      endLine = line;

      const next = this.scriptElements[line + 1];
      if (!next || !next.overlap || !next.overlap.mode) break;
      line++;
    }

    return { units: collected, endLine };
  }

  _clusterReady(units) {
    return units.every((unit) => !!this._engineForUnit(unit).getCached(unit.key));
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
    if (!this.engine.isReady) return;

    const firstLineUnits = this._unitsForLine(this.cursorLine) || [];
    const clusterUnits = this._clusterUnits(this.cursorLine);
    const atomicClusterSize = clusterUnits.length > firstLineUnits.length ? clusterUnits.length : 0;
    const unitBudget = Math.max(LOOKAHEAD_UNITS, atomicClusterSize);
    const secondsBudget = atomicClusterSize > 0 ? Infinity : LOOKAHEAD_SEC;

    let line = this.cursorLine;
    let unit = this.cursorUnit;
    let seconds = 0;
    let count = 0;
    let guard = 0;
    const guardLimit = Math.max(500, this.scriptElements.length + unitBudget + 2);

    while (count < unitBudget && seconds < secondsBudget && guard++ < guardLimit) {
      const units = this._unitsForLine(line);
      if (!units) break;
      if (unit >= units.length) {
        line++;
        unit = 0;
        continue;
      }

      const u = units[unit];
      const engine = this._engineForUnit(u);
      const cached = engine.getCached(u.key);
      if (cached) {
        seconds += cached.duration / (u.playbackRate || 1);
      } else {
        // A cold engine answers with null rather than throwing. Discarding that
        // is what turned a missing supporting engine into a permanent stall, so
        // start it instead. Once per engine per run: a failed init clears its
        // own single-flight latch, and this pump runs every 60 ms, so retrying
        // unconditionally would spawn a worker and a model download sixteen
        // times a second. One attempt, then the watchdog has the last word.
        if (engine.request(u, count) === null && !engine.isReady && !this._autoInitAttempted.has(engine)) {
          this._autoInitAttempted.add(engine);
          engine.init().catch(() => {
            /* the watchdog reports a stall that persists */
          });
        }
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
    let clusterSeconds = 0;
    let guard = 0;

    while (guard++ < 500) {
      const units = this._unitsForLine(line);
      if (!units) return { seconds: seconds + clusterSeconds, hitEnd: true };
      if (unit >= units.length) {
        line++;
        unit = 0;
        continue;
      }

      let lineSeconds = 0;
      const first = units[unit];
      for (; unit < units.length; unit++) {
        const u = units[unit];
        const engine = this._engineForUnit(u);
        const cached = engine.getCached(u.key);
        if (!cached) return { seconds: seconds + clusterSeconds, hitEnd: false };
        lineSeconds += cached.duration / (u.playbackRate || 1);
        lineSeconds += Math.max(0, u.leadPause || 0);
      }

      if ((first.overlapMode || 'sequential') === 'simultaneous') {
        clusterSeconds = Math.max(clusterSeconds, lineSeconds);
      } else {
        seconds += clusterSeconds;
        clusterSeconds = lineSeconds;
      }

      line++;
      unit = 0;
    }

    return { seconds: seconds + clusterSeconds, hitEnd: false };
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
    // The ordinary cap prevents a malformed cursor from spinning forever, but
    // once an atomic overlap cluster starts it must be placed whole regardless
    // of how many chunks it contains.
    while (guard++ < 128 || this.clusterRemaining > 0) {
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

      const engine = this._engineForUnit(unit);
      const buffer = engine.getCached(unit.key);
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
        overlapMode: unit.overlapMode || 'sequential',
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
        concurrent: this.getActiveLineIndices().filter((i) => i !== entry.lineIndex),
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
        truncated: !!this.lineTruncated.get(line),
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
      this.stallDeadline = Date.now() + STALL_TIMEOUT_MS;
      this._setState(PLAYBACK_STATES.BUFFERING);
      if (this.visualizer) this.visualizer.setSpeaking(false);
    } else if (!starving && this.playbackState === PLAYBACK_STATES.BUFFERING) {
      this.stallDeadline = 0;
      this._setState(PLAYBACK_STATES.PLAYING);
    }

    if (this.playbackState === PLAYBACK_STATES.BUFFERING) this._checkStall();
  }

  /**
   * Buffering forever is not a state anything recovers from on its own, and it
   * is indistinguishable on screen from buffering that is about to end. If the
   * runway has been empty for long enough that no plausible render is still
   * coming, name the engine that owes us audio and stop pretending.
   */
  _checkStall() {
    if (!this.stallDeadline || Date.now() < this.stallDeadline) return;
    if (this._readyRunway().seconds > 0) {
      this.stallDeadline = Date.now() + STALL_TIMEOUT_MS;
      return;
    }

    const blocked = this._blockedEngine();
    this.stallDeadline = 0;
    this.stop();

    if (blocked && blocked !== this.engine) {
      this._emitSupportingEngineError(blocked);
      return;
    }

    const label = blocked ? blocked.capabilities.label || blocked.capabilities.id : 'The voice engine';
    this.emit('engineError', {
      engineId: blocked ? blocked.capabilities.id : this.engineId,
      code: 'render_stalled',
      message: `${label} stopped producing audio, so playback could not continue.`,
    });
  }

  /** The engine that owes the cursor its next unit, if there is one. */
  _blockedEngine() {
    const unit = this._unitAtCursor();
    return unit ? this._engineForUnit(unit) : null;
  }

  _tick() {
    if (this.playbackState !== PLAYBACK_STATES.PLAYING && this.playbackState !== PLAYBACK_STATES.BUFFERING) {
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
        truncated: !!this.lineTruncated.get(line),
      });
    }
    this._stopTick();
    this._resetPlayheadState();
    this.currentIndex = 0;
    this.cursorLine = 0;
    this.cursorUnit = 0;
    this.reachedEnd = false;
    this.primed = false;
    this.stallDeadline = 0;
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

  /** Render ahead without playing, so the first Play has no wait. */
  prewarm() {
    if (this.scriptElements.length === 0) return null;
    if (this.engine.capabilities.metered) return;

    const engine = this.engine;
    const unitGeneration = this.prewarmGeneration;

    if (this.engineId === ENGINE_IDS.CHATTERBOX || this.engineId === ENGINE_IDS.RUNPOD) {
      const active = this._studioPrewarmTask;
      if (active && active.engine === engine && active.unitGeneration === unitGeneration) {
        return active.promise;
      }

      const promise = this._runStudioPrewarm(engine, unitGeneration);
      this._studioPrewarmTask = { engine, unitGeneration, promise };
      return promise;
    }

    if (!engine.isReady) return null;
    this._queuePrewarm(engine);
    return null;
  }

  async _runStudioPrewarm(engine, unitGeneration) {
    // Only claim "not ready" if we do not already have a safe playback runway
    // from the current index forward. A fresh load has zero prepared units and
    // correctly publishes canPlay: false before the first await, preventing
    // Play from starting on unrendered audio. But after a seek or once audio is
    // prepared, preserving a valid canPlay: true allows synchronous playback resumption.
    const initialRunway = this._studioRunwayStatus(this._studioRenderUnits().units, STUDIO_UNKNOWN_RENDER_RATE, false);
    const label = engine.capabilities?.label || 'Studio';
    if (this._ownsStudioPrewarm(engine, unitGeneration)) {
      this._setRenderStatus({
        visible: true,
        active: true,
        canPlay: initialRunway.canPlay,
        engineLabel: label,
        error: null,
      });
    }

    try {
      if (!engine.isReady) {
        if (this.engineId === ENGINE_IDS.CHATTERBOX) {
          // Selecting Studio Local is explicit consent to install it, but a saved
          // selection can outlive browser storage eviction. Re-check the installed
          // files before starting a background load so merely opening a script can
          // never silently trigger another 1.4 GB download.
          const status = await this.getChatterboxCacheStatus();
          if (!status.installed || !this._ownsStudioPrewarm(engine, unitGeneration)) return false;
          await engine.init();
        } else if (this.engineId === ENGINE_IDS.RUNPOD) {
          const key = engine.getApiKey?.()?.trim();
          if (!key || !this._ownsStudioPrewarm(engine, unitGeneration)) return false;
          await engine.init();
        }
      }

      if (!engine.isReady || !this._ownsStudioPrewarm(engine, unitGeneration)) return false;

      // The plan now spans every engine in the cast, so the supporting ones have
      // to be up before any of it is requested — a cold engine returns null from
      // `request()` and the batch would silently bank nothing. Only actually
      // wait when something is cold: with everything warm this stays on the
      // synchronous path and the first batch still leaves in this turn.
      if (this._coldEngines().length > 0) {
        const { failed } = await this._initRequiredEngines();
        if (!this._ownsStudioPrewarm(engine, unitGeneration)) return false;
        if (failed.length > 0) {
          this._emitSupportingEngineError(failed[0]);
          return false;
        }
      }

      await this._queueStudioPrewarm(engine, unitGeneration);
      return true;
    } catch (err) {
      console.warn(`${label} background pre-render notice:`, err);
      if (this._ownsStudioPrewarm(engine, unitGeneration)) {
        this._setRenderStatus({
          visible: true,
          active: false,
          canPlay: false,
          engineLabel: label,
          error: err?.message || `${label} audio could not be rendered.`,
          message: err?.message || `${label} audio could not be rendered.`,
        });
      }
      return false;
    } finally {
      if (this._studioPrewarmTask && this._studioPrewarmTask.unitGeneration === unitGeneration) {
        this._studioPrewarmTask = null;
      }
    }
  }

  _ownsStudioPrewarm(engine, unitGeneration) {
    return (
      unitGeneration === this.prewarmGeneration &&
      (this.engineId === ENGINE_IDS.CHATTERBOX || this.engineId === ENGINE_IDS.RUNPOD) &&
      this.engine === engine
    );
  }

  _setRenderStatus(status) {
    this.renderStatus = { ...this.renderStatus, ...status };
    this.emit('renderProgress', this.renderStatus);
  }

  _queuePrewarm(engine) {
    if (engine !== this.engine || !engine.isReady || this.scriptElements.length === 0) return;
    if (this.playbackState === PLAYBACK_STATES.PLAYING) return;

    this.cursorLine = this.currentIndex;
    this.cursorUnit = 0;

    let line = this.currentIndex;
    let unit = 0;
    let count = 0;
    let guard = 0;
    const guardLimit = Math.max(60, this.scriptElements.length + DEFAULT_PREWARM_UNITS + 2);

    while (count < DEFAULT_PREWARM_UNITS && guard++ < guardLimit) {
      const units = this._unitsForLine(line);
      if (!units) break;
      if (unit >= units.length) {
        line++;
        unit = 0;
        continue;
      }
      const renderUnit = units[unit];
      engine.request(renderUnit, count)?.catch(() => {});
      count++;
      unit++;
    }
  }

  /**
   * Keep Studio Local busy while idle without flooding the worker with an entire
   * screenplay (and a fresh transferable copy of its reference audio) at once.
   */
  _studioRenderUnits() {
    const units = [];
    const appendRange = (start, end) => {
      for (let line = start; line < end && units.length <= STUDIO_PREWARM_UNITS; line++) {
        // Every unit, whichever engine speaks it. Counting only the Chatterbox
        // half made the bar reach 100% — and `canPlay` go true — while the
        // narration had had no work done on it at all.
        units.push(...(this._unitsForLine(line) || []));
      }
    };
    // What the listener will hear next is rendered first. Wrapping around later
    // still fills the bar for the whole script and makes a reset instant.
    appendRange(this.currentIndex, this.scriptElements.length);
    appendRange(0, this.currentIndex);
    return {
      units: units.slice(0, STUDIO_PREWARM_UNITS),
      truncated: units.length > STUDIO_PREWARM_UNITS,
    };
  }

  _studioRunwayStatus(units, renderRate, previousCanPlay = false) {
    if (!units || units.length === 0) {
      return { totalSeconds: 0, contiguousSeconds: 0, requiredSeconds: 0, canPlay: true };
    }
    const totalSeconds = units.reduce((sum, unit) => sum + (unit.estimatedDuration || 0), 0);
    let contiguousSeconds = 0;
    for (const unit of units) {
      if (!this._preparedStudioKeys.has(unit.key)) break;
      contiguousSeconds += unit.estimatedDuration || 0;
    }
    const effectiveRate = Math.max(0, renderRate || STUDIO_UNKNOWN_RENDER_RATE) / Math.max(0.5, this.masterSpeed);
    const deficit = Math.max(0, 1 - effectiveRate * STUDIO_RENDER_SAFETY_FACTOR);
    const minCushion = Math.min(10, totalSeconds);
    const requiredSeconds = Math.min(
      totalSeconds,
      Math.max(minCushion, Math.min(STUDIO_MIN_RUNWAY_SECONDS, totalSeconds * deficit)),
    );
    const isSafeRunway =
      contiguousSeconds >= requiredSeconds || (contiguousSeconds >= minCushion && effectiveRate >= 1.0);

    return {
      totalSeconds,
      contiguousSeconds,
      requiredSeconds,
      canPlay: previousCanPlay || isSafeRunway,
    };
  }

  async _queueStudioPrewarm(engine, unitGeneration) {
    const renderPlan = this._studioRenderUnits();
    const units = renderPlan.units;
    const totalSeconds = units.reduce((sum, unit) => sum + (unit.estimatedDuration || 0), 0);
    if (renderPlan.truncated || totalSeconds > STUDIO_CACHE_DURATION_BUDGET) {
      throw new Error(
        'This script is too long for the bounded Studio render cache. Split it into smaller parts for uninterrupted playback.',
      );
    }
    let completed = units.filter((unit) => this._preparedStudioKeys.has(unit.key)).length;
    let completedSeconds = units.reduce(
      (sum, unit) => sum + (this._preparedStudioKeys.has(unit.key) ? unit.estimatedDuration || 0 : 0),
      0,
    );
    let measuredAudioSeconds = 0;
    let measuredWallSeconds = 0;
    let canPlay = false;
    const startedAt = Date.now();

    const label = engine.capabilities?.label || 'Studio';
    const publish = (active, error = null) => {
      const renderRate =
        measuredWallSeconds > 0 ? measuredAudioSeconds / measuredWallSeconds : STUDIO_UNKNOWN_RENDER_RATE;
      const runway = this._studioRunwayStatus(units, renderRate, canPlay);
      canPlay = runway.canPlay;
      const remainingAudio = Math.max(0, totalSeconds - completedSeconds);
      const etaSeconds = renderRate > 0 ? remainingAudio / renderRate : null;
      this._setRenderStatus({
        visible: true,
        active,
        canPlay,
        engineLabel: label,
        completed,
        total: units.length,
        percent: totalSeconds > 0 ? Math.min(100, Math.round((completedSeconds / totalSeconds) * 100)) : 100,
        etaSeconds,
        renderedSeconds: completedSeconds,
        runwaySeconds: runway.contiguousSeconds,
        requiredSeconds: runway.requiredSeconds,
        error,
        message: error || (active ? `Pre-rendering ${label} audio` : `${label} audio ready`),
      });
    };

    // How much work to hand the engine beyond the group being awaited. A remote
    // engine that batches across a fleet only reaches full speed once its queue
    // holds enough units to form several concurrent requests — awaiting one
    // group of six left three GPU workers behind a single request in flight.
    // Progress and the playable-runway check still advance every group, so the
    // bar and the moment playback can start are unaffected. A local engine
    // declares no batching and gets exactly the behaviour it had before.
    const engineCapabilities = engine.capabilities || {};
    const lookahead = Math.max(
      0,
      Math.max(1, engineCapabilities.concurrency || 1) * Math.max(1, engineCapabilities.batchSize || 1) -
        STUDIO_PREWARM_BATCH_UNITS,
    );

    publish(completed < units.length);
    for (
      let offset = 0;
      offset < units.length && this._ownsStudioPrewarm(engine, unitGeneration);
      offset += STUDIO_PREWARM_BATCH_UNITS
    ) {
      const batchUnits = units
        .slice(offset, offset + STUDIO_PREWARM_BATCH_UNITS)
        .filter((unit) => !this._preparedStudioKeys.has(unit.key));
      if (batchUnits.length === 0) continue;

      // Queue the units after this group without waiting on them. They carry a
      // later priority, so the group being awaited is still served first, and
      // the engine dedupes by key when the loop reaches them.
      const lookaheadStart = offset + STUDIO_PREWARM_BATCH_UNITS;
      for (let ahead = lookaheadStart; ahead < Math.min(units.length, lookaheadStart + lookahead); ahead++) {
        const unit = units[ahead];
        if (this._preparedStudioKeys.has(unit.key)) continue;
        this._engineForUnit(unit)
          .request(unit, ahead)
          ?.catch(() => {});
      }

      const batchStartedAt = Date.now();
      const results = await Promise.allSettled(
        batchUnits.map((unit, index) => {
          // Route per unit: under hybrid casting this batch can hold narration
          // bound for Kokoro alongside dialogue bound for Chatterbox.
          const unitEngine = this._engineForUnit(unit);
          const request = unitEngine.request(unit, offset + index);
          return (
            request || Promise.reject(new Error(`${unitEngine.capabilities.label} stopped accepting render requests.`))
          );
        }),
      );
      if (!this._ownsStudioPrewarm(engine, unitGeneration)) return;
      const failure = results.find((result) => {
        if (result.status !== 'rejected') return false;
        const msg = String(result.reason?.message || result.reason || '');
        return !msg.includes('dropped') && !msg.includes('Abort');
      });
      if (failure) throw failure.reason;

      const wallSeconds = (Date.now() - batchStartedAt) / 1000;
      const batchSeconds = batchUnits.reduce((sum, unit) => sum + (unit.estimatedDuration || 0), 0);
      const renderedAudioSeconds = results.reduce(
        (sum, result) => sum + (result.status === 'fulfilled' ? result.value?.duration || 0 : 0),
        0,
      );
      // Fast persistent-cache hits should not be mistaken for synthesis speed.
      if (wallSeconds >= 0.25 && renderedAudioSeconds > 0) {
        measuredWallSeconds += wallSeconds;
        measuredAudioSeconds += renderedAudioSeconds || batchSeconds;
      }
      // Only mark units whose render request actually fulfilled as prepared.
      // When a seek or cast change drops in-flight worker requests via
      // `dropPendingExcept`, marking dropped units would permanently claim
      // unrendered audio is ready, inflating the runway and causing playback stalls.
      for (let i = 0; i < batchUnits.length; i++) {
        const unit = batchUnits[i];
        const result = results[i];
        if (result && result.status === 'fulfilled') {
          this._preparedStudioKeys.add(unit.key);
          completed++;
          completedSeconds += unit.estimatedDuration || 0;
        }
      }
      publish(completed < units.length);
    }

    if (this._ownsStudioPrewarm(engine, unitGeneration)) {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (measuredWallSeconds === 0 && elapsed >= 0.25) {
        measuredWallSeconds = elapsed;
        measuredAudioSeconds = completedSeconds;
      }
      canPlay = completed === units.length || canPlay;
      publish(false);
    }
  }

  // ----------------------------------------------------------------- audio export

  /**
   * Why this script cannot be exported right now, or null when it can.
   *
   * Web Speech is the one engine with nothing to record: it drives the browser's
   * own synthesiser, which speaks straight to the output device and hands back
   * no buffer at all.
   */
  exportBlockedReason() {
    if (this.scriptElements.length === 0) return 'Load a screenplay first.';
    if (this.engineId === ENGINE_IDS.WEB_SPEECH || this.usingWebSpeechFallback) {
      return "The browser's built-in voice cannot be recorded. Pick a neural engine to export.";
    }
    if (typeof globalThis.OfflineAudioContext !== 'function') {
      return 'This browser cannot render audio offline.';
    }
    return null;
  }

  /**
   * Every unit of the whole script, grouped into the clusters that have to be
   * placed together.
   *
   * Deliberately not `_studioRenderUnits()`: that plan starts at the playhead
   * and wraps around, which is right for filling a cache and wrong for a file,
   * where line one has to come first.
   */
  getExportPlan() {
    const clusters = [];
    let line = 0;
    let guard = 0;

    while (line < this.scriptElements.length && guard++ < this.scriptElements.length + 2) {
      const { units, endLine } = this._clusterSpan(line);
      if (units.length > 0) clusters.push(units);
      line = Math.max(line + 1, endLine + 1);
    }

    return clusters;
  }

  /** Route one unit to the engine that owns its voice and ask for its audio. */
  requestUnit(unit, priority = 0) {
    return this._engineForUnit(unit).request(unit, priority);
  }

  get isExporting() {
    return this._exportAbort !== null;
  }

  _setExportStatus(status) {
    this.exportStatus = { ...this.exportStatus, ...status };
    this.emit('exportProgress', this.exportStatus);
  }

  /** @returns {boolean} whether there was an export to stop. */
  cancelExport(reason = 'Export cancelled.') {
    if (!this._exportAbort) return false;
    this._exportAbort.abort(new DOMException(reason, 'AbortError'));
    return true;
  }

  /**
   * Render the whole script to one file.
   *
   * Playback is stopped first rather than shared with: the export needs the
   * engines' request queues and the render pumps would keep moving the cursor
   * underneath it. Cancelling, or any failure, leaves no half-written file.
   *
   * @returns {Promise<{filename: string, seconds: number, codec: string}|null>}
   *          null when the export was cancelled.
   */
  async exportAudio({ title = 'ScriptReader table read' } = {}) {
    const blocked = this.exportBlockedReason();
    if (blocked) {
      this._setExportStatus({ active: false, phase: 'idle', error: blocked, message: blocked });
      throw new Error(blocked);
    }
    if (this._exportAbort) throw new Error('An export is already running.');

    this.stop();

    const generation = ++this.exportGeneration;
    const controller = new AbortController();
    this._exportAbort = controller;
    const owns = () => generation === this.exportGeneration;

    this._setExportStatus({
      active: true,
      phase: 'preparing',
      completed: 0,
      total: 0,
      percent: 0,
      renderedSeconds: 0,
      etaSeconds: null,
      error: null,
      message: 'Preparing the export',
    });

    try {
      const clusters = this.getExportPlan();
      const nativeSampleRate = this._requiredEngines().reduce(
        (rate, engine) => Math.max(rate, engine.capabilities?.nativeSampleRate || 0),
        24000,
      );

      const result = await runExportJob({
        clusters,
        title,
        nativeSampleRate,
        signal: controller.signal,
        // Engines start only once the listener has chosen a destination. A cold
        // model can take tens of seconds to load, which is far longer than the
        // browser keeps the Download click alive as a gesture the save dialog
        // will accept.
        prepare: async () => {
          const { primaryError, failed } = await this._initRequiredEngines();
          if (!owns()) throw new DOMException('Export superseded.', 'AbortError');
          // `_initRequiredEngines` reports the active engine through
          // `primaryError` and keeps it out of `failed`, so checking only
          // `failed` would start rendering against an engine that never loaded
          // and surface its outage as a generic queue error much later.
          if (primaryError || !this.engine.isReady) {
            throw (
              primaryError ||
              new Error(`${this.engine.capabilities?.label || 'The voice engine'} could not be started.`)
            );
          }
          if (failed.length > 0) {
            throw new Error(`${failed[0].capabilities?.label || 'A voice engine'} could not be started.`);
          }
        },
        requestUnit: (unit, priority) => this.requestUnit(unit, priority),
        onProgress: (status) => {
          if (owns()) this._setExportStatus({ ...status, message: EXPORT_PHASE_MESSAGES[status.phase] || '' });
        },
      });

      if (!owns()) return null;
      this._setExportStatus({
        active: false,
        phase: 'done',
        percent: 100,
        error: null,
        message: `Saved ${result.filename}`,
      });
      return result;
    } catch (err) {
      const cancelled = err?.name === 'AbortError';
      if (owns()) {
        this._setExportStatus({
          active: false,
          phase: 'idle',
          error: cancelled ? null : err?.message || 'The export could not be completed.',
          message: cancelled ? 'Export cancelled' : err?.message || 'The export could not be completed.',
        });
      }
      if (cancelled) return null;
      throw err;
    } finally {
      if (this._exportAbort === controller) this._exportAbort = null;
      // The pre-render was stood down to make room; put it back to work.
      if (owns()) this.prewarm();
    }
  }

  // ------------------------------------------------------------- transport API

  async play() {
    if (this.scriptElements.length === 0) return;
    if (this.playbackState === PLAYBACK_STATES.PLAYING || this.playbackState === PLAYBACK_STATES.BUFFERING) {
      return;
    }
    // An export holds the engines' request queues and would starve playback
    // into a permanent buffering state. Pressing Play means the file mattered
    // less than hearing the read now, so the export stands down.
    if (this._exportAbort) {
      this.cancelExport('Playback started, so the export was stopped.');
    }

    // The runway check exists to protect a *cold* start, not a resume. A pause
    // does not clear canPlay, but an in-between voice or cast edit does — and
    // that is an ordinary thing to do while paused. Without this exception,
    // the Play button reads as enabled while paused (transport-bar only force-
    // disables in IDLE) yet clicking it lands right back on this gate and
    // silently re-arms prewarm instead of resuming.
    const isPausedResume =
      this.playbackState === PLAYBACK_STATES.PAUSED && !this.usingWebSpeechFallback && this.engine.isReady;
    const isStudioEngine = this.engineId === ENGINE_IDS.CHATTERBOX || this.engineId === ENGINE_IDS.RUNPOD;
    if (!isPausedResume && isStudioEngine && !this.renderStatus.canPlay) {
      this.prewarm();
      return;
    }

    const generation = ++this.playGeneration;

    const scheduler = await this._ensureAudio();
    if (generation !== this.playGeneration) return;

    if (!scheduler) {
      this.usingWebSpeechFallback = true;
      this._setState(PLAYBACK_STATES.PLAYING);
      this._runWebSpeech();
      return;
    }

    // Resuming from pause: the context clock was frozen, so everything already
    // scheduled is still valid and simply continues.
    if (this.playbackState === PLAYBACK_STATES.PAUSED && !this.usingWebSpeechFallback && this.engine.isReady) {
      this._setState(PLAYBACK_STATES.PLAYING);
      this._startTick();
      return;
    }

    // Every engine the cast uses, not just the selected one. Under hybrid
    // casting the narration is spoken by a second engine, and a cold engine
    // answers `request()` with a silent null — which the render pumps read as
    // "not ready yet, try next tick" and wait on forever.
    const { primaryError: initError, failed } = await this._initRequiredEngines();
    if (generation !== this.playGeneration) return;

    if (this.engine.isReady && failed.length > 0) {
      this._setState(PLAYBACK_STATES.IDLE);
      this._emitSupportingEngineError(failed[0]);
      return;
    }

    if (!this.engine.isReady) {
      // A failed local model download is exactly what the browser's built-in
      // voice exists to cover. A missing or rejected API key is not: quietly
      // dropping someone who chose paid cloud voices onto the robotic fallback
      // would hide the one thing they need to be told, and they would conclude
      // the cloud engine simply sounds bad.
      if (this.engine.capabilities.onUnavailable === 'error') {
        this._setState(PLAYBACK_STATES.IDLE);
        this.emit('engineError', {
          engineId: this.engineId,
          code: (initError && initError.code) || 'unavailable',
          message:
            (initError && initError.message) || 'This voice engine is not available. Check Voice Engine settings.',
        });
        return;
      }

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
    // This sets BUFFERING directly rather than by starving into it, so the
    // watchdog has to be armed here too or the opening stall goes unwatched.
    this.stallDeadline = Date.now() + STALL_TIMEOUT_MS;
    // A fresh run earns each engine another attempt.
    this._autoInitAttempted.clear();

    this.cursorLine = Math.max(0, Math.min(this.scriptElements.length - 1, fromIndex));
    this.cursorUnit = 0;
    this.currentIndex = this.cursorLine;

    this._setState(PLAYBACK_STATES.BUFFERING);
    this._startTick();
  }

  async pause() {
    if (this.playbackState !== PLAYBACK_STATES.PLAYING && this.playbackState !== PLAYBACK_STATES.BUFFERING) {
      return;
    }

    this._stopTick();
    // Paused time is not stalled time; the clock restarts when playback does.
    this.stallDeadline = 0;
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

  stop({ preservePending = false, preservePrewarm = false } = {}) {
    this.playGeneration++;
    if (!preservePrewarm) {
      this.prewarmGeneration++;
      const isStudioEngine = this.engineId === ENGINE_IDS.CHATTERBOX || this.engineId === ENGINE_IDS.RUNPOD;
      if (isStudioEngine && this.scriptElements.length > 0) {
        const label = this.engine?.capabilities?.label || 'Studio';
        // `_setRenderStatus` is a shallow merge, so a percent left over from the
        // completed run would sit next to canPlay:false — a bar reading 100%
        // above a Play button that refuses to start.
        this._setRenderStatus({
          visible: true,
          active: false,
          canPlay: false,
          engineLabel: label,
          completed: 0,
          percent: 0,
          error: null,
          message: `${label} pre-render paused`,
        });
      }
    }
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

    // An export owns the engines' request queues while it runs. Flushing them
    // here would reject its in-flight units as "dropped" and fail the file over
    // a transport action the listener sees as unrelated to it.
    if (!preservePending && !preservePrewarm && !this.isExporting) {
      this._dropPendingExcept([]);
    }

    this._stopTick();

    if (this.scheduler) {
      this.scheduler.stopAll();
    }

    this._resetPlayheadState();
    this.reachedEnd = false;
    this.primed = false;
    this.stallDeadline = 0;
    this._autoInitAttempted.clear();

    if (this.visualizer) this.visualizer.setSpeaking(false);

    this._setState(PLAYBACK_STATES.IDLE);
  }

  seek(index) {
    const target = Math.max(0, Math.min(this.scriptElements.length - 1, index));
    const wasPlaying =
      this.playbackState === PLAYBACK_STATES.PLAYING || this.playbackState === PLAYBACK_STATES.BUFFERING;

    // Preserve the prewarm state across seeks: repositioning within the same
    // script does not invalidate already synthesized audio in the persistent
    // store or the prepared-keys set. Resetting prewarm here would disarm
    // `canPlay` and set percent to 0, which swallows the replay on line click or scrub.
    this.stop({ preservePending: true, preservePrewarm: true });
    this.currentIndex = target;
    this.cursorLine = target;
    this.cursorUnit = 0;

    // Abandon lookahead the jump made irrelevant, keeping only what we now need.
    // An export in flight is the exception: its units are not lookahead, and
    // dropping them would fail a render the seek has nothing to do with.
    if (!this.isExporting) {
      this._dropPendingExcept(this._upcomingKeys(target, 8));
    }

    this.emit('lineChange', {
      index: this.currentIndex,
      element: this.scriptElements[this.currentIndex],
    });

    this.prewarm();

    if (wasPlaying) {
      this.play();
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
    if (this.playbackState === PLAYBACK_STATES.PLAYING || this.playbackState === PLAYBACK_STATES.BUFFERING) {
      this.seek(this.currentIndex);
    } else {
      this.prewarm();
    }
  }

  // ------------------------------------------------------------------ previews

  /**
   * Eagerly pre-render audition audio for a character or narrator in the background
   * so clicking "Listen" plays immediately from local cache without waiting.
   */
  async prewarmAudition(voiceId, sampleText = null, tuning = {}, targetEngineId = null) {
    if (!voiceId) return null;
    const engineId = targetEngineId || this.engineId;
    const engine =
      !targetEngineId || targetEngineId === this.engineId
        ? this.engine
        : this._engines.get(targetEngineId) || this.engine;

    if (!engine || !engine.isReady || !engine.request) return null;
    const profile = getVoiceById(voiceId, engineId);
    if (!profile) return null;
    const text = sampleText || profile.sampleLine;

    try {
      const units = buildPreviewUnits({
        text,
        voiceProfile: profile,
        tuning: {
          pitchOffset: tuning.pitchOffset || 0,
          speedMultiplier: tuning.speedMultiplier || 1.0,
          direction: tuning.direction || '',
        },
        masterSpeed: this.masterSpeed,
        engine,
      });

      return Promise.all(units.map((unit, i) => engine.request(unit, 900 + i))).catch((err) => {
        console.warn('Audition prewarm notice:', err);
      });
    } catch (err) {
      console.warn('Audition prewarm build failed:', err);
      return null;
    }
  }

  /**
   * Audition a voice in the Cast Studio. Resolves when playback actually ends,
   * so the calling UI can flip its button back at the right moment.
   */
  async previewVoice(
    voiceId,
    sampleText = null,
    pitchOffset = 0,
    speedMultiplier = 1.0,
    direction = '',
    targetEngineId = null,
    onStateChange = null,
  ) {
    this.stop({ preservePrewarm: true });

    const engineId = targetEngineId || this.engineId;
    const engine =
      !targetEngineId || targetEngineId === this.engineId
        ? this.engine
        : this._engines.get(targetEngineId) || this.engine;
    const token = ++this.previewToken;
    // Auditions have to resolve against the pool the chosen engine can speak with
    const profile = getVoiceById(voiceId, engineId);
    const text = sampleText || profile.sampleLine;

    await this._ensureAudio();

    let initError = null;
    if (!engine.isReady) {
      onStateChange?.('preparing');
      try {
        await engine.init();
      } catch (err) {
        initError = err;
        console.warn(`Engine ${engineId} preview init failed:`, err);
      }
    }
    if (token !== this.previewToken) return;

    if (!engine.isReady && engine.capabilities.onUnavailable === 'error') {
      if (this.visualizer) this.visualizer.setSpeaking(false);
      onStateChange?.('error');
      this.emit('engineError', {
        engineId,
        code: (initError && initError.code) || 'preview_unavailable',
        message: (initError && initError.message) || 'The selected voice could not be prepared for audition.',
      });
      return;
    }

    if (engine.isReady && this.scheduler) {
      try {
        onStateChange?.('rendering');
        const units = buildPreviewUnits({
          text,
          voiceProfile: profile,
          tuning: { pitchOffset, speedMultiplier, direction },
          masterSpeed: this.masterSpeed,
          engine,
        });

        // Requested together rather than one after the next: on a cloud engine a
        // serial loop would cost one full round trip per chunk, turning a
        // two-sentence audition into several seconds of silence. Playback order
        // is unaffected — the scheduler places them by index afterwards.
        const buffers = await Promise.all(units.map((unit, i) => engine.request(unit, i)));
        if (token !== this.previewToken) return;

        if (this.visualizer) {
          this.visualizer.setSpeaking(true, { badgeColor: '#F59E0B' });
        }
        onStateChange?.('playing');

        this.scheduler.resetTimeline(this.scheduler.currentTime + 0.06);
        let endAt = this.scheduler.currentTime;
        units.forEach((unit, i) => {
          endAt = this.scheduler.schedule(unit, buffers[i]).endAt;
        });

        await this._waitUntil(endAt + 0.05, token);
        if (token === this.previewToken && this.visualizer) {
          this.visualizer.setSpeaking(false);
        }
        onStateChange?.('idle');
        return;
      } catch (err) {
        console.warn(`Engine ${engineId} preview failed:`, err);
        if (token !== this.previewToken) return;
        engine.dropPendingExcept([]);
        if (this.visualizer) this.visualizer.setSpeaking(false);
        onStateChange?.('error');
        if (engine.capabilities.onUnavailable === 'error') {
          this.emit('engineError', {
            engineId,
            code: err.code || 'preview_failed',
            message: err.message || 'The selected voice could not be auditioned.',
          });
          return;
        }
      }
    }

    if (this.visualizer) {
      this.visualizer.setSpeaking(true, { badgeColor: '#F59E0B' });
    }
    onStateChange?.('playing');

    await new Promise((resolve) => {
      this._previewResolve = resolve;
      this.webSpeechEngine.speakLine({
        text,
        voiceProfile: profile,
        nuance: { cleanSpeech: text },
        speedMultiplier: speedMultiplier * this.masterSpeed,
        onEnd: () => {
          if (token === this.previewToken) {
            if (this.visualizer) this.visualizer.setSpeaking(false);
            onStateChange?.('idle');
            resolve();
          }
        },
        onError: () => {
          if (token === this.previewToken) {
            if (this.visualizer) this.visualizer.setSpeaking(false);
            onStateChange?.('idle');
            resolve();
          }
        },
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
        concurrent: [],
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

      if (!nuance.cleanSpeech || !nuance.cleanSpeech.trim()) {
        advance();
        return;
      }

      this.webSpeechEngine.speakLine({
        text: element.text,
        voiceProfile: voice,
        nuance,
        speedMultiplier: (tuning.speedMultiplier || 1) * this.masterSpeed * (nuance.speedMod || 1),
        onEnd: advance,
        onError: advance,
      });
    };

    step();
  }
}

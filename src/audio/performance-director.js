import { analyzeLineNuance } from '../screenplay/emotion-analyzer.js';
import { composeInstructions } from './instruction-composer.js';
import { ENGINE_IDS, makeCacheKey } from './engine-contract.js';
import {
  resolvePacing,
  interruptTrimSec,
  OVERLAP_TIMING,
  DEFAULT_PACE
} from '../screenplay/overlap-pacing.js';

/**
 * Performance Director
 *
 * Turns a script element plus its cast assignment into concrete render units —
 * the atoms the scheduler lays end to end on the audio timeline.
 *
 * The central trick is separating *tempo* from *pitch*:
 *   - Kokoro's `speed` parameter changes tempo while preserving pitch.
 *   - Web Audio's `playbackRate` changes both.
 * So to raise pitch by `p` without speeding the line up, we synthesise at
 * `tempo / p` and play back at rate `p`. The two cancel out on tempo and
 * compound on pitch. That is what makes "(authoritative)" actually sound
 * authoritative instead of merely 2% slower.
 */

// Long paragraphs are split so playback can start before the whole block is
// rendered, and so no single request approaches Kokoro's token ceiling.
const MAX_CHUNK_CHARS = 190;
const MIN_CHUNK_CHARS = 45;

// `playbackRate` resamples, which moves the formants along with the pitch — the
// tape-speed effect. Past roughly ±12% that stops reading as "a different person"
// and starts reading as "something is wrong with the audio", so every pitch input
// below is scaled and clamped to stay inside that window.
//
// The two inputs are not treated equally, because a *constant* shift and a
// *per-line* shift cost very different amounts. A character who always sits 7%
// low just sounds like a bigger person; a line that jumps 7% mid-scene sounds
// broken. So the per-character budget stays generous and the per-line ones are
// cut.

// Per-voice pitch character from the catalog, at half strength: enough to hear
// Onyx sit below Lily, not enough to sound resampled. Constant per character,
// so it is the cheapest place to spend pitch.
const VOICE_PITCH_STRENGTH = 0.5;

// The cast studio's pitch slider is ±50. At the old 0.5 the top half of the
// slider's travel bought nothing — it ran straight into the clamp — while
// sounding progressively more resampled. At 0.22 the full ±50 maps to ±11% and
// lands just inside the window, so every position on the slider does something
// and none of them sound artificial.
const USER_PITCH_STRENGTH = 0.22;

// Bounds on the final pitch ratio, asymmetric on purpose: a downward shift reads
// as a larger person, which is plausible, while an upward shift reads as a child
// or a cartoon and becomes objectionable sooner.
const PITCH_MIN = 0.88;
const PITCH_MAX = 1.12;

// Kokoro's `speed` is well behaved over roughly this range. Below 0.8 it
// over-lengthens phones and smears transients — the "mushy" failure that the
// old 0.55 floor allowed whenever a raised pitch made the director ask for
// `tempo / pitch` well under 1.
const SYNTH_SPEED_MIN = 0.80;
const SYNTH_SPEED_MAX = 2.00;

// Gap *between* lines, before the line's own emotional lead-in is added.
const CUE_GAPS_MS = {
  beforeSceneHeading: 620,
  afterSceneHeading: 480,
  afterTransition: 430,
  actionToDialogue: 280,
  dialogueToAction: 260,
  sameSpeaker: 110,
  dialogueToDialogue: 240,
  default: 200
};

// Gaps between chunks of one continuous line.
const CHUNK_GAP_MS = 70;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Render a cast-studio pitch slider position as the shift it actually produces.
 *
 * The slider runs ±50 and used to be printed as "+50%", which was never true —
 * it was +25% before this change and is +11% after. Showing the real figure
 * keeps the control honest and stops anyone reading the extremes as broken.
 */
export function formatPitchOffset(sliderValue) {
  const percent = Math.round((sliderValue || 0) * USER_PITCH_STRENGTH);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/**
 * Split spoken text at sentence boundaries, greedily packing into chunks.
 * Falls back to clause boundaries for runaway sentences.
 */
export function chunkSpeech(text, maxChars = MAX_CHUNK_CHARS) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const sentences = trimmed.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [trimmed];

  const chunks = [];
  let current = '';

  const pushWithinLimit = (value) => {
    let remaining = value.trim();
    while (remaining.length > maxChars) {
      let splitAt = remaining.lastIndexOf(' ', maxChars);
      if (splitAt <= 0) splitAt = maxChars;
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) chunks.push(remaining);
  };

  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;

    if (piece.length > maxChars) {
      flush();
      // Break an over-long sentence on commas rather than mid-phrase.
      const clauses = piece.split(/,\s*/);
      let clauseBuffer = '';
      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i] + (i < clauses.length - 1 ? ',' : '');
        if (clauseBuffer && (clauseBuffer.length + clause.length + 1) > maxChars) {
          pushWithinLimit(clauseBuffer);
          clauseBuffer = clause;
        } else {
          clauseBuffer = clauseBuffer ? `${clauseBuffer} ${clause}` : clause;
        }
      }
      if (clauseBuffer.trim()) pushWithinLimit(clauseBuffer);
      continue;
    }

    if (current && (current.length + piece.length + 1) > maxChars) {
      flush();
    }
    current = current ? `${current} ${piece}` : piece;

    if (current.length >= maxChars - MIN_CHUNK_CHARS) {
      flush();
    }
  }
  flush();

  return chunks.length > 0 ? chunks : [trimmed];
}

/**
 * Theatrical handoff gap between two consecutive script elements, in ms.
 *
 * `pacing` is the listener's transport setting; the passage and per-line pace
 * ride on the element itself, so every existing caller keeps working unchanged.
 * A negative result is an overlap, not a gap.
 */
export function computeCueGapMs(prevElement, element, pacing = DEFAULT_PACE, masterSpeed = 1.0) {
  if (!prevElement) return 0;

  const overlap = element.overlap;
  if (overlap && overlap.mode === 'simultaneous') {
    // Placed against the other speaker's start, not against this gap at all.
    return 0;
  }
  if (overlap && overlap.mode === 'interrupt') {
    const sec = overlap.offsetMs != null
      ? Math.abs(overlap.offsetMs) / 1000
      : OVERLAP_TIMING.interruptOverlapSec;
    return -(sec * 1000) / Math.max(0.5, masterSpeed);
  }

  let base;
  // A new scene needs air on both sides, not just after the slug line.
  if (element.type === 'SCENE_HEADING') base = CUE_GAPS_MS.beforeSceneHeading;
  else if (prevElement.type === 'SCENE_HEADING') base = CUE_GAPS_MS.afterSceneHeading;
  else if (prevElement.type === 'TRANSITION') base = CUE_GAPS_MS.afterTransition;
  else if (prevElement.type === 'ACTION' && element.type === 'DIALOGUE') base = CUE_GAPS_MS.actionToDialogue;
  else if (prevElement.type === 'DIALOGUE' && element.type === 'ACTION') base = CUE_GAPS_MS.dialogueToAction;
  else if (prevElement.type === 'DIALOGUE' && element.type === 'DIALOGUE') {
    base = prevElement.character === element.character
      ? CUE_GAPS_MS.sameSpeaker
      : CUE_GAPS_MS.dialogueToDialogue;
  } else {
    base = CUE_GAPS_MS.default;
  }

  // The gap into a line takes that line's pace, so "[[pace: droning]]" placed
  // ahead of a speech lengthens the silence before it — the drone starts there.
  const { gapFactor } = resolvePacing({
    global: pacing,
    passage: element.pace,
    line: element.linePace
  });
  return (base * gapFactor) / Math.max(0.5, masterSpeed);
}

/**
 * Resolve the synthesis + playback parameters for one line.
 */
function resolveDelivery({ nuance, voiceProfile, tuning, masterSpeed, paceTempo = 1.0, caps = null }) {
  const charSpeed = tuning && tuning.speedMultiplier ? tuning.speedMultiplier : 1.0;
  const pitchOffset = tuning && tuning.pitchOffset ? tuning.pitchOffset : 0;

  const voicePitch = 1 + ((voiceProfile.defaultPitch || 1.0) - 1) * VOICE_PITCH_STRENGTH;
  const userPitch = 1 + (pitchOffset / 100) * USER_PITCH_STRENGTH;

  // Bound what a *direction* alone may do, before the voice's own character and
  // the user's controls are layered on. Wide enough to hear a whisper differ
  // from a shout; narrow enough that no line ever outruns the listener.
  const emotionSpeed = clamp(nuance.speedMod || 1, 0.82, 1.15);
  // Tighter than the speed bound. Emotion already reaches the listener through
  // tempo, level, lead-in pause and the punctuation Kokoro reads; per-line pitch
  // wobble is the most audible of those inputs and the least informative, so it
  // gets the smallest share of the resampling budget.
  const emotionPitch = clamp(nuance.pitchMod || 1, 0.94, 1.06);

  // Perceived tempo the listener should hear. Pace is a separate multiplier
  // rather than part of `emotionSpeed`, so an authored fast passage is not
  // squeezed through the narrow bound a direction alone has to respect.
  const tempo = clamp(
    (voiceProfile.defaultSpeed || 1.0) * charSpeed * emotionSpeed * paceTempo * masterSpeed,
    0.6,
    2.0
  );

  // Perceived pitch relative to the voice's natural register.
  const pitch = clamp(voicePitch * userPitch * emotionPitch, PITCH_MIN, PITCH_MAX);

  // A model that acts on "whisper" itself has already dropped its level. Applying
  // the full mix cut on top lands the line at ~30% instead of ~55%. Halve the
  // deviation rather than discarding it — the direction still shapes the mix, it
  // just is not applied twice.
  const rawGain = nuance.gainMod || 1;
  const gain = caps && caps.supportsInstructions
    ? clamp(1 + (rawGain - 1) * 0.5, 0.25, 1.6)
    : clamp(rawGain, 0.25, 1.6);

  // `gain`, `filter`, and `pan` are engine-agnostic on purpose: PlaybackScheduler
  // applies them to the Web Audio graph after synthesis. So "(over comms)" keeps
  // its radio band-limit and "(whispering)" keeps its level drop on every engine.
  // Only the *speed and pitch* half of a direction moves into words below; the
  // mix half never does.
  const common = { gain, filter: nuance.filter || null, pitch };

  if (!caps || caps.supportsSpeed) {
    if (caps && caps.usesInstructionPitch) {
      // OpenAI changes tempo without shifting pitch. Keep its render untouched
      // by Web Audio resampling and express register as acting direction.
      return { ...common, synthSpeed: clamp(tempo, 0.25, 4), playbackRate: 1.0, tempo };
    }
    // Kokoro: `speed` moves tempo while preserving pitch, `playbackRate` moves
    // both. Synthesise at tempo/pitch and play at pitch — they cancel on tempo
    // and compound on pitch.
    const synthSpeed = clamp(tempo / pitch, SYNTH_SPEED_MIN, SYNTH_SPEED_MAX);
    // What the listener will actually hear, which is not what was asked for
    // whenever either clamp engaged. The lookahead budget is built from this, so
    // reporting the *requested* tempo made the runway estimate wrong in exactly
    // the cases where the estimate mattered most.
    return { ...common, synthSpeed, playbackRate: pitch, tempo: synthSpeed * pitch };
  }

  // Instruction-only engines approximate tempo in prose and keep their native
  // register. This remains as the fallback contract for any future engine that
  // supports direction but no numeric rate.
  return { ...common, synthSpeed: 1.0, playbackRate: 1.0, tempo };
}

/**
 * Rough spoken duration, used only to budget lookahead before audio exists.
 *
 * On an engine with no speed control, tempo is a request phrased in words and
 * the model honours it only loosely, so the estimate tracks reality better when
 * the tempo term is damped rather than taken at face value.
 */
function estimateDuration(text, tempo, honoursTempo = true) {
  const effective = honoursTempo ? tempo : 1 + (tempo - 1) * 0.4;
  return Math.max(0.5, (text.length / 14.5) / Math.max(0.5, effective));
}

/**
 * Capabilities used when no engine is supplied. Matches Kokoro, which keeps every
 * existing caller — and every test that builds units without an engine —
 * behaving exactly as before.
 */
const DEFAULT_CAPS = {
  id: ENGINE_IDS.KOKORO,
  supportsSpeed: true,
  supportsInstructions: false,
  maxChunkChars: MAX_CHUNK_CHARS
};

function capsFor(engine) {
  return (engine && engine.capabilities) || DEFAULT_CAPS;
}

function voiceIdFor(engine, voiceProfile) {
  if (engine && typeof engine.resolveVoiceId === 'function') {
    return engine.resolveVoiceId(voiceProfile);
  }
  return voiceProfile.kokoroId || voiceProfile.id || 'af_heart';
}

/**
 * Build the render units for a single script element.
 *
 * @returns {Array<Object>} units, possibly empty when the line has nothing to speak
 */
export function buildLineUnits({
  element,
  prevElement = null,
  lineIndex = 0,
  voiceProfile,
  tuning = null,
  pan = 0,
  masterSpeed = 1.0,
  pacing = DEFAULT_PACE,
  engine = null
}) {
  if (!element) return [];

  const caps = capsFor(engine);
  const nuance = element.nuance || analyzeLineNuance({
    text: element.text,
    parenthetical: element.parenthetical || '',
    speakerType: element.type === 'DIALOGUE' ? 'CHARACTER' : element.type
  });

  const spoken = nuance.cleanSpeech || element.text || '';
  const chunks = chunkSpeech(spoken, caps.maxChunkChars);
  if (chunks.length === 0) return [];

  const pace = resolvePacing({
    global: pacing,
    passage: element.pace,
    line: element.linePace
  });

  const delivery = resolveDelivery({
    nuance, voiceProfile, tuning, masterSpeed, paceTempo: pace.tempoFactor, caps
  });
  const voiceId = voiceIdFor(engine, voiceProfile);

  // Composed once per line, not per chunk: the direction is a property of the
  // character and the line, so every chunk of a speech must carry the identical
  // string or the model re-invents the delivery halfway through.
  const instructions = caps.supportsInstructions
    ? composeInstructions({
        direction: (tuning && tuning.direction) || '',
        nuance,
        tempo: delivery.tempo,
        pitch: delivery.pitch,
        persona: voiceProfile.tone || '',
        isNarration: element.type !== 'DIALOGUE',
        includeTempo: !caps.supportsSpeed
      })
    : null;

  const overlapMode = (element.overlap && element.overlap.mode) || 'sequential';
  const isOverlapping = overlapMode !== 'sequential';

  const cueGap = computeCueGapMs(prevElement, element, pacing, masterSpeed);
  // A line that barges in does not also get to take a breath first. Without
  // this, an interrupting line marked "(beat)" would carry a 750ms lead-in and
  // arrive half a second *after* the line it is supposed to be cutting off.
  const emotionalLead = isOverlapping ? 0 : (nuance.leadPauseMs || 0) * pace.gapFactor;
  const chunkGap = CHUNK_GAP_MS / Math.max(0.5, masterSpeed);

  // Which edge this line measures its start from.
  const firstAnchor =
      overlapMode === 'simultaneous' ? 'prevHead'
    : overlapMode === 'interrupt'    ? 'prevTail'
    : overlapMode === 'continuation' ? 'chunk'
    :                                  'sequential';

  const firstLead =
      overlapMode === 'simultaneous' ? OVERLAP_TIMING.simultaneousStaggerSec
    : overlapMode === 'continuation' ? chunkGap / 1000
    : (cueGap + emotionalLead) / 1000;

  // Standing slightly back is what keeps a simultaneous pair readable rather
  // than a wall of sound. An interrupter stays at full level — it is winning.
  const gain = overlapMode === 'simultaneous'
    ? clamp(delivery.gain * OVERLAP_TIMING.simultaneousDuck, 0.25, 1.6)
    : delivery.gain;

  // Being cut off is trimmed off this line's own tail, which is what lets the
  // scheduler place it without yet knowing when the interrupter arrives.
  const timingScale = 1 / Math.max(0.5, masterSpeed);
  const trimTailSec = element.cutOff ? interruptTrimSec() * timingScale : 0;

  return chunks.map((text, chunkIndex) => ({
    lineIndex,
    chunkIndex,
    chunkCount: chunks.length,
    isFirstChunk: chunkIndex === 0,
    isLastChunk: chunkIndex === chunks.length - 1,

    text,
    voiceId,
    engineId: caps.id,
    synthSpeed: delivery.synthSpeed,
    instructions,
    playbackRate: delivery.playbackRate,
    gain,
    filter: delivery.filter,
    pan,

    anchor: chunkIndex === 0 ? firstAnchor : 'chunk',
    overlapMode,
    // Silence before this unit, in seconds. Negative means it starts early.
    leadPause: chunkIndex === 0 ? firstLead : chunkGap / 1000,
    trimTailSec: chunkIndex === chunks.length - 1 ? trimTailSec : 0,
    interruptFadeSec: chunkIndex === chunks.length - 1 ? 0.08 * timingScale : 0,

    estimatedDuration: estimateDuration(text, delivery.tempo, caps.supportsSpeed),
    key: makeCacheKey({
      engineId: caps.id,
      voiceId,
      synthSpeed: delivery.synthSpeed,
      instructions,
      text
    }),

    nuance,
    character: element.character
  }));
}

/**
 * Units for a one-off audition in the Cast Studio — no cue gaps, no lead-in.
 */
export function buildPreviewUnits({
  text,
  voiceProfile,
  tuning = null,
  nuance = null,
  masterSpeed = 1.0,
  engine = null
}) {
  const caps = capsFor(engine);
  const resolvedNuance = nuance || analyzeLineNuance({ text, speakerType: 'CHARACTER' });
  const spoken = resolvedNuance.cleanSpeech || text || '';
  const chunks = chunkSpeech(spoken, caps.maxChunkChars);
  if (chunks.length === 0) return [];

  const delivery = resolveDelivery({ nuance: resolvedNuance, voiceProfile, tuning, masterSpeed, caps });
  const voiceId = voiceIdFor(engine, voiceProfile);

  const instructions = caps.supportsInstructions
    ? composeInstructions({
        direction: (tuning && tuning.direction) || '',
        nuance: resolvedNuance,
        tempo: delivery.tempo,
        pitch: delivery.pitch,
        persona: voiceProfile.tone || '',
        includeTempo: !caps.supportsSpeed
      })
    : null;

  return chunks.map((chunkText, chunkIndex) => ({
    lineIndex: -1,
    chunkIndex,
    chunkCount: chunks.length,
    isFirstChunk: chunkIndex === 0,
    isLastChunk: chunkIndex === chunks.length - 1,

    text: chunkText,
    voiceId,
    engineId: caps.id,
    synthSpeed: delivery.synthSpeed,
    instructions,
    playbackRate: delivery.playbackRate,
    gain: delivery.gain,
    filter: delivery.filter,
    // An audition is heard on its own, centred, at the pace the chips are set to.
    pan: 0,

    anchor: chunkIndex === 0 ? 'sequential' : 'chunk',
    overlapMode: 'sequential',
    trimTailSec: 0,
    leadPause: chunkIndex === 0 ? 0 : CHUNK_GAP_MS / 1000,
    estimatedDuration: estimateDuration(chunkText, delivery.tempo, caps.supportsSpeed),
    key: makeCacheKey({
      engineId: caps.id,
      voiceId,
      synthSpeed: delivery.synthSpeed,
      instructions,
      text: chunkText
    }),

    nuance: resolvedNuance,
    character: 'PREVIEW'
  }));
}

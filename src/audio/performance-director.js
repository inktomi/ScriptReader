import { analyzeLineNuance } from '../screenplay/emotion-analyzer.js';

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

// Per-voice pitch character from the catalog, at half strength: enough to hear
// Onyx sit below Lily, not enough to sound resampled.
const VOICE_PITCH_STRENGTH = 0.5;

// The cast studio's pitch slider is ±50; mapping it at half strength keeps the
// extremes expressive rather than cartoonish.
const USER_PITCH_STRENGTH = 0.5;

const PACING_FACTORS = {
  natural: 1.0,
  dramatic: 1.45,
  snappy: 0.55
};

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
 * Split spoken text at sentence boundaries, greedily packing into chunks.
 * Falls back to clause boundaries for runaway sentences.
 */
export function chunkSpeech(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_CHUNK_CHARS) return [trimmed];

  const sentences = trimmed.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [trimmed];

  const chunks = [];
  let current = '';

  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;

    if (piece.length > MAX_CHUNK_CHARS) {
      flush();
      // Break an over-long sentence on commas rather than mid-phrase.
      const clauses = piece.split(/,\s*/);
      let clauseBuffer = '';
      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i] + (i < clauses.length - 1 ? ',' : '');
        if (clauseBuffer && (clauseBuffer.length + clause.length + 1) > MAX_CHUNK_CHARS) {
          chunks.push(clauseBuffer.trim());
          clauseBuffer = clause;
        } else {
          clauseBuffer = clauseBuffer ? `${clauseBuffer} ${clause}` : clause;
        }
      }
      if (clauseBuffer.trim()) chunks.push(clauseBuffer.trim());
      continue;
    }

    if (current && (current.length + piece.length + 1) > MAX_CHUNK_CHARS) {
      flush();
    }
    current = current ? `${current} ${piece}` : piece;

    if (current.length >= MAX_CHUNK_CHARS - MIN_CHUNK_CHARS) {
      flush();
    }
  }
  flush();

  return chunks.length > 0 ? chunks : [trimmed];
}

/**
 * Theatrical handoff gap between two consecutive script elements, in ms.
 */
export function computeCueGapMs(prevElement, element, pacing = 'natural', masterSpeed = 1.0) {
  if (!prevElement) return 0;

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

  const factor = PACING_FACTORS[pacing] || 1.0;
  return (base * factor) / Math.max(0.5, masterSpeed);
}

/**
 * Resolve the synthesis + playback parameters for one line.
 */
function resolveDelivery({ nuance, voiceProfile, tuning, masterSpeed }) {
  const charSpeed = tuning && tuning.speedMultiplier ? tuning.speedMultiplier : 1.0;
  const pitchOffset = tuning && tuning.pitchOffset ? tuning.pitchOffset : 0;

  const voicePitch = 1 + ((voiceProfile.defaultPitch || 1.0) - 1) * VOICE_PITCH_STRENGTH;
  const userPitch = 1 + (pitchOffset / 100) * USER_PITCH_STRENGTH;

  // Bound what a *direction* alone may do, before the voice's own character and
  // the user's controls are layered on. Wide enough to hear a whisper differ
  // from a shout; narrow enough that no line ever outruns the listener.
  const emotionSpeed = clamp(nuance.speedMod || 1, 0.82, 1.15);
  const emotionPitch = clamp(nuance.pitchMod || 1, 0.90, 1.10);

  // Perceived tempo the listener should hear.
  const tempo = clamp(
    (voiceProfile.defaultSpeed || 1.0) * charSpeed * emotionSpeed * masterSpeed,
    0.6,
    2.0
  );

  // Perceived pitch relative to the voice's natural register.
  const pitch = clamp(voicePitch * userPitch * emotionPitch, 0.72, 1.35);

  // Ask Kokoro for a tempo that, once the pitch shift stretches it, lands on `tempo`.
  const kokoroSpeed = clamp(tempo / pitch, 0.55, 2.2);

  return {
    kokoroSpeed,
    playbackRate: pitch,
    gain: clamp(nuance.gainMod, 0.25, 1.6),
    filter: nuance.filter || null,
    tempo
  };
}

function makeKey(voiceId, kokoroSpeed, text) {
  return `${voiceId}|${kokoroSpeed.toFixed(3)}|${text}`;
}

/** Rough spoken duration, used only to budget lookahead before audio exists. */
function estimateDuration(text, tempo) {
  return Math.max(0.5, (text.length / 14.5) / Math.max(0.5, tempo));
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
  masterSpeed = 1.0,
  pacing = 'natural'
}) {
  if (!element) return [];

  const nuance = element.nuance || analyzeLineNuance({
    text: element.text,
    parenthetical: element.parenthetical || '',
    speakerType: element.type === 'DIALOGUE' ? 'CHARACTER' : element.type
  });

  const spoken = nuance.cleanSpeech || element.text || '';
  const chunks = chunkSpeech(spoken);
  if (chunks.length === 0) return [];

  const delivery = resolveDelivery({ nuance, voiceProfile, tuning, masterSpeed });
  const voiceId = voiceProfile.kokoroId || voiceProfile.id || 'af_heart';

  const cueGap = computeCueGapMs(prevElement, element, pacing, masterSpeed);
  const emotionalLead = (nuance.leadPauseMs || 0) * (PACING_FACTORS[pacing] || 1.0);
  const chunkGap = CHUNK_GAP_MS / Math.max(0.5, masterSpeed);

  return chunks.map((text, chunkIndex) => ({
    lineIndex,
    chunkIndex,
    chunkCount: chunks.length,
    isFirstChunk: chunkIndex === 0,
    isLastChunk: chunkIndex === chunks.length - 1,

    text,
    voiceId,
    kokoroSpeed: delivery.kokoroSpeed,
    playbackRate: delivery.playbackRate,
    gain: delivery.gain,
    filter: delivery.filter,

    // Silence before this unit, in seconds.
    leadPause: chunkIndex === 0 ? (cueGap + emotionalLead) / 1000 : chunkGap / 1000,

    estimatedDuration: estimateDuration(text, delivery.tempo),
    key: makeKey(voiceId, delivery.kokoroSpeed, text),

    nuance,
    character: element.character
  }));
}

/**
 * Units for a one-off audition in the Cast Studio — no cue gaps, no lead-in.
 */
export function buildPreviewUnits({ text, voiceProfile, tuning = null, nuance = null, masterSpeed = 1.0 }) {
  const resolvedNuance = nuance || analyzeLineNuance({ text, speakerType: 'CHARACTER' });
  const spoken = resolvedNuance.cleanSpeech || text || '';
  const chunks = chunkSpeech(spoken);
  if (chunks.length === 0) return [];

  const delivery = resolveDelivery({ nuance: resolvedNuance, voiceProfile, tuning, masterSpeed });
  const voiceId = voiceProfile.kokoroId || voiceProfile.id || 'af_heart';

  return chunks.map((chunkText, chunkIndex) => ({
    lineIndex: -1,
    chunkIndex,
    chunkCount: chunks.length,
    isFirstChunk: chunkIndex === 0,
    isLastChunk: chunkIndex === chunks.length - 1,

    text: chunkText,
    voiceId,
    kokoroSpeed: delivery.kokoroSpeed,
    playbackRate: delivery.playbackRate,
    gain: delivery.gain,
    filter: delivery.filter,

    leadPause: chunkIndex === 0 ? 0 : CHUNK_GAP_MS / 1000,
    estimatedDuration: estimateDuration(chunkText, delivery.tempo),
    key: makeKey(voiceId, delivery.kokoroSpeed, chunkText),

    nuance: resolvedNuance,
    character: 'PREVIEW'
  }));
}

/**
 * Composes the free-text direction handed to an instruction-following TTS engine.
 *
 * This is the whole reason a cloud engine is worth having. On Kokoro, "(whispering)"
 * has to be *manufactured* — synthesise slower, drop the gain, resample the pitch —
 * because the model cannot be told anything. Here the direction is simply said out
 * loud to a model that can act, which is both more convincing and free of the
 * resampling artefacts the arithmetic introduces.
 *
 * Two properties this file is built around:
 *
 * 1. **Stable-to-volatile ordering.** Everything before the emotion clause is a
 *    property of the character and identical across their whole part; only the
 *    last two clauses move line to line. That is also the order the model weights
 *    correctly — later, more specific instructions dominate earlier ones.
 *
 * 2. **Banding.** Tempo and pitch are quantised into a handful of buckets rather
 *    than interpolated. This is a cache-correctness requirement, not a stylistic
 *    one: un-banded, a tempo of 0.9013 and one of 0.9017 produce different
 *    instruction strings, different hashes, and therefore different cache keys —
 *    so nudging the master-speed slider would re-render, and on a metered engine
 *    re-buy, the entire lookahead. Banded, almost every nudge lands in the same
 *    bucket and costs nothing.
 */

// The longest instruction any single line should carry. Well under the model's
// input budget; the point is to stop a pathological per-character direction from
// crowding out the line itself.
const MAX_INSTRUCTION_CHARS = 900;

const PACE_BANDS = [
  { max: 0.86, text: 'Speak slowly and deliberately.' },
  { max: 0.95, text: 'Speak a little slower than conversational.' },
  { max: 1.06, text: 'Speak at a natural conversational pace.' },
  { max: 1.16, text: 'Speak briskly, with urgency.' },
  { max: Infinity, text: 'Speak fast and clipped, close to rapid-fire.' }
];

const REGISTER_BANDS = [
  { max: 0.90, text: 'Pitch your voice noticeably lower than usual.' },
  { max: 0.97, text: 'Sit slightly lower in your register.' },
  // Natural. Saying "speak at your normal pitch" spends instruction budget
  // telling the model to do what it was going to do anyway, and reads as a
  // constraint rather than an absence of one.
  { max: 1.04, text: null },
  { max: 1.12, text: 'Sit slightly higher in your register.' },
  { max: Infinity, text: 'Pitch your voice noticeably higher than usual.' }
];

/**
 * Written as stage directions to a human reader rather than as parameter names.
 * That is the register the model responds to, and it is the register the
 * screenwriter was already writing in.
 */
const EMOTION_INSTRUCTIONS = {
  whisper: 'Whisper. Breathy and intimate, barely above a murmur.',
  shout: 'Shout. Full projection, urgent and hard-edged.',
  angry: 'Angry — clipped consonants, tight jaw, controlled fury.',
  sad: 'Heavy-hearted. Let the line sag; do not perform the grief.',
  fear: 'Frightened. Short breaths, unsteady, words crowding together.',
  excited: 'Bright and elated, riding the top of the breath.',
  sarcastic: 'Dry and deadpan. Land the irony with timing, not emphasis.',
  tender: 'Warm and gentle, close to the listener.',
  commanding: 'Authoritative and unhurried. Nothing to prove.',
  hesitant: 'Uncertain. Search for the words; let the pauses sit.',
  coughing: 'Rough and gravelled, as if the throat is raw.',
  gasping: 'Breathless, as if having just run.',
  sighing: 'Weary — begin on the tail of a sigh.',
  chuckling: 'Amused, with a smile audible under the words.',
  comms: 'Clipped radio-procedure cadence.',
  synthetic: 'Flat, evenly metered, machine-like.',
  narration: 'Read as film narration: even, unhurried, uncoloured.',
  beat: 'Take a beat before speaking. Let the pause land.',
  neutral: null
};

function band(bands, value) {
  for (const entry of bands) {
    if (value <= entry.max) return entry.text;
  }
  return bands[bands.length - 1].text;
}

function clampLength(text, max) {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastStop = cut.lastIndexOf('.');
  return lastStop > max * 0.6 ? cut.slice(0, lastStop + 1) : cut.trimEnd();
}

/**
 * Build the `instructions` string for one render unit.
 *
 * @param {Object}  args
 * @param {string}  args.direction  Free text the user wrote for this character in
 *                                  the Cast Studio. The most important input here.
 * @param {Object}  args.nuance     From `analyzeLineNuance` — carries the emotion
 *                                  key and the screenwriter's raw parenthetical.
 * @param {number}  args.tempo      Perceived tempo the listener should hear.
 * @param {number}  args.pitch      Perceived register relative to the voice's own.
 * @param {string}  args.persona    Voice-profile character (the catalog `tone`).
 * @param {boolean} args.isNarration
 * @returns {string|null} null when there is nothing worth saying, so the request
 *                        omits the field rather than sending a paragraph that
 *                        amounts to "be normal".
 */
export function composeInstructions({
  direction = '',
  nuance = {},
  tempo = 1.0,
  pitch = 1.0,
  persona = '',
  isNarration = false,
  includeTempo = true
} = {}) {
  const stableParts = [];
  const lineParts = [];

  if (persona) stableParts.push(persona.trim().replace(/\.?$/, '.'));
  if (direction && direction.trim()) stableParts.push(direction.trim().replace(/\.?$/, '.'));

  const register = band(REGISTER_BANDS, pitch);
  if (register) stableParts.push(register);
  if (includeTempo) stableParts.push(band(PACE_BANDS, tempo));

  const emotion = EMOTION_INSTRUCTIONS[nuance.emotionKey];
  if (emotion) lineParts.push(emotion);

  // The screenwriter's own parenthetical, verbatim and last, because it is the
  // most specific thing anyone said about this line. Passed through rather than
  // mapped through the emotion table so that "(in a terrible Cockney accent)"
  // survives — precisely the kind of direction the table cannot represent and
  // this engine can actually act on.
  if (nuance.directionText) {
    lineParts.push(`Direction for this line: ${nuance.directionText}.`);
  }

  if (isNarration && !direction) {
    lineParts.push('This is screen action, not a character speaking.');
  }

  const specific = lineParts.filter(Boolean).join(' ').trim();
  const stable = stableParts.filter(Boolean).join(' ').trim();
  if (!specific && !stable) return null;

  // Line-specific direction is the information that cannot be recovered from
  // the voice profile. Reserve its full budget first, then trim the reusable
  // persona/direction prefix to fit around it.
  if (specific.length >= MAX_INSTRUCTION_CHARS) {
    return clampLength(specific, MAX_INSTRUCTION_CHARS);
  }
  const stableBudget = MAX_INSTRUCTION_CHARS - specific.length - (specific && stable ? 1 : 0);
  return [clampLength(stable, stableBudget), specific].filter(Boolean).join(' ').trim();
}

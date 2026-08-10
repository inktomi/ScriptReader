import { analyzeLineNuance } from './emotion-analyzer.js';

/**
 * Overlap and pacing.
 *
 * Two things a script can say about how it should be *performed* rather than
 * what is said:
 *
 *   - who talks over whom, and whether the first speaker gets to finish
 *   - how fast a passage runs, so an argument crackles and a lecture drones
 *
 * The notation is Fountain wherever Fountain has an opinion (`^` for dual
 * dialogue, a trailing `--` for a speaker cut off mid-thought) and `[[pace: x]]`
 * notes otherwise — notes being the one syntax a screenwriting app will carry
 * through without trying to render it.
 *
 * Detection lives here rather than in either parser because an interruption is
 * a relationship *between* two elements, and neither parser can see a
 * relationship while it is still deciding what the next line even is. Running
 * as a post-pass over the finished element array also means the PDF path gets
 * everything that is derivable from text alone for free.
 */

// ---------------------------------------------------------------- pace profiles

/**
 * `gapFactor` scales the silence between lines; `tempoFactor` scales delivery
 * speed. Pace is both — an argument where only the pauses shorten still has
 * every line delivered at the same measured rate, which is not what fast sounds
 * like.
 *
 * natural / dramatic / snappy keep the exact gap factors the transport chips
 * have always used, so turning this feature on changes nothing for a script
 * that does not ask for it. Their tempo factors are deliberately mild; the big
 * moves belong to the authored-only profiles.
 */
export const PACE_PROFILES = {
  rapid:    { key: 'rapid',    label: 'Rapid',    icon: '⚡', gapFactor: 0.45, tempoFactor: 1.10 },
  snappy:   { key: 'snappy',   label: 'Snappy',   icon: '⚡', gapFactor: 0.55, tempoFactor: 1.06 },
  natural:  { key: 'natural',  label: 'Natural',  icon: '🎭', gapFactor: 1.00, tempoFactor: 1.00 },
  measured: { key: 'measured', label: 'Measured', icon: '🎼', gapFactor: 1.20, tempoFactor: 0.96 },
  dramatic: { key: 'dramatic', label: 'Dramatic', icon: '🎬', gapFactor: 1.45, tempoFactor: 0.95 },
  droning:  { key: 'droning',  label: 'Droning',  icon: '💤', gapFactor: 1.70, tempoFactor: 0.88 }
};

export const DEFAULT_PACE = 'natural';

const PACE_ALIASES = {
  fast: 'rapid', quick: 'rapid', quickly: 'rapid', 'rapid-fire': 'rapid',
  rapidfire: 'rapid', hurried: 'rapid', urgent: 'rapid',
  slow: 'droning', slowly: 'droning', drone: 'droning', ponderous: 'droning',
  laborious: 'droning', dragging: 'droning',
  deliberate: 'measured', even: 'measured', steady: 'measured',
  theatrical: 'dramatic'
};

/** Resolve any authored spelling to a profile key, or null if unrecognised. */
export function normalizePaceKey(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (PACE_PROFILES[key]) return key;
  return PACE_ALIASES[key] || null;
}

function profile(key) {
  return PACE_PROFILES[key] || PACE_PROFILES[DEFAULT_PACE];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Compose the three layers that have an opinion about pace.
 *
 * They multiply rather than override. The transport chip is the listener's
 * standing intent ("give me a fast rehearsal read"); `[[pace: droning]]` is the
 * author saying this passage is slower *than its neighbours*. Override would
 * mean the Snappy chip silently stops working the moment a script uses a pace
 * mark. Multiplying keeps the chip in charge of total running time while
 * preserving the author's ordering at every chip setting.
 *
 * The clamps are load-bearing: snappy x rapid x (rapidly) multiplies out to
 * 0.19, which is not a fast read, it is an unlistenable one.
 */
export function resolvePacing({ global = DEFAULT_PACE, passage = DEFAULT_PACE, line = null } = {}) {
  const g = profile(global);
  const p = profile(passage);
  const l = line ? profile(line) : PACE_PROFILES[DEFAULT_PACE];

  return {
    key: line || (passage !== DEFAULT_PACE ? passage : global),
    gapFactor: clamp(g.gapFactor * p.gapFactor * l.gapFactor, 0.25, 2.20),
    tempoFactor: clamp(g.tempoFactor * p.tempoFactor * l.tempoFactor, 0.80, 1.25)
  };
}

// ------------------------------------------------------------- overlap timing

/**
 * Every number here is a judgement about performance, not a fact about audio.
 * Kept in one block because they will be tuned by ear.
 */
export const OVERLAP_TIMING = {
  // The interrupter starts this far before the victim's line would have ended.
  interruptOverlapSec: 0.30,
  // ...and the victim keeps talking this far into the collision before being cut.
  interruptCutDelaySec: 0.15,
  // Simultaneous speakers are offset by a hair so their attacks do not phase-lock
  // into sounding like one strange voice.
  simultaneousStaggerSec: 0.03,
  // The second voice in a simultaneous pair sits slightly back, which is what
  // makes the pair readable instead of a wall.
  simultaneousDuck: 0.90
};

/** How much of the cut-off line's tail is discarded. */
export function interruptTrimSec() {
  return Math.max(0, OVERLAP_TIMING.interruptOverlapSec - OVERLAP_TIMING.interruptCutDelaySec);
}

// ------------------------------------------------------------------- detection

// A dash at the very end survives closing quotes and brackets: `that the--"`.
const CUT_OFF_END_REGEX = /(--+|—|–)\s*["'’”)\]]*\s*$/;
const PICK_UP_START_REGEX = /^\s*["'‘“(\[]*\s*(--+|—|–)\s*(?=\S)/;

// Narrow on purpose. `over (him|her|them)` is excluded because it matches
// "(leaning over her)", and `both`/`together` because they match "(both amused)".
const INTERRUPT_PAREN_REGEX =
  /\b(interrupt(s|ing|ed)?|cutting (in|off)|cuts (in|off)|breaking in|butting in|talking over|speaking over|jumping in)\b/i;
const SIMULTANEOUS_PAREN_REGEX =
  /\b(simultaneous(ly)?|overlapping|at the same time|in unison|over each other)\b/i;

/**
 * Per-line pace read off a direction.
 *
 * `adverb` may appear anywhere in the direction, because an adverb is always
 * describing the delivery. A bare adjective is not: "(panicked, rapid breath)"
 * is about someone's breathing, and "(quick smile)" is about their face. Those
 * only count when the fragment is *nothing but* the pace word.
 *
 * `measured`, `steadily` and `even` are deliberately absent throughout: they
 * already match EMOTIONS.COMMANDING, and counting them twice would compound the
 * same slowdown.
 */
const PACE_PAREN_PATTERNS = [
  {
    key: 'rapid',
    adverb: /\b(rapidly|quickly|hurriedly|breakneck|rapid[- ]fire|rattling off)\b/i,
    // "breathless" is deliberately absent: it describes a state, not a tempo,
    // and it already reads as its own emotion.
    bare: /^(rapid|quick|fast|hurried|clipped|racing)$/i
  },
  {
    key: 'droning',
    adverb: /\b(slowly|drawling|droning|ponderously|laboriously|drawn out)\b/i,
    bare: /^(slow|drone|drones|ponderous|labou?red|dragging|glacial)$/i
  }
];

const PACE_NOTE_REGEX = /^pace\s*[:=]\s*([a-z-]+)\s*$/i;

/**
 * Read a `[[ ... ]]` note body as a pace directive.
 * @returns {string|null} a profile key, or null if the note is something else.
 */
export function parsePaceDirective(noteBody) {
  const match = (noteBody || '').trim().match(PACE_NOTE_REGEX);
  if (!match) return null;
  return normalizePaceKey(match[1]);
}

function matchLinePace(parenthetical) {
  const direction = (parenthetical || '').trim();
  if (!direction) return null;

  const fragments = direction.split(/[,;]/).map(f => f.trim()).filter(Boolean);

  for (const { key, adverb, bare } of PACE_PAREN_PATTERNS) {
    if (adverb.test(direction)) return key;
    if (fragments.some(f => bare.test(f))) return key;
  }
  return null;
}

// --------------------------------------------------------------- the post-pass

/**
 * Everyone speaking at the same moment as `index` — that element, plus each
 * earlier one it is stacked on top of. A lone speaker is a cluster of one.
 */
function simultaneousClusterEndingAt(elements, index) {
  const cluster = [];
  let i = index;

  while (i >= 0 && elements[i] && elements[i].type === 'DIALOGUE') {
    cluster.push(elements[i]);
    const overlap = elements[i].overlap;
    if (!overlap || overlap.mode !== 'simultaneous') break;
    i--;
  }

  return cluster;
}

/**
 * Resolve overlap relationships and per-line pace across a parsed script.
 *
 * Adjacency is strict: only the immediately preceding element counts. If an
 * action line sits between two speeches the author put a beat there, and
 * speaking across it would flatten a deliberate silence.
 *
 * @param {Object} parsed the object a parser returns; mutated and returned
 */
export function annotateScriptFlow(parsed) {
  const elements = (parsed && parsed.elements) || [];

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];

    if (element.linePace === undefined) element.linePace = null;
    if (element.pace === undefined) element.pace = DEFAULT_PACE;
    if (element.cutOff === undefined) element.cutOff = false;
    if (element.overlap === undefined) element.overlap = null;

    element.linePace = matchLinePace(element.parenthetical);

    if (element.type !== 'DIALOGUE') continue;

    const prev = i > 0 ? elements[i - 1] : null;
    if (!prev || prev.type !== 'DIALOGUE') {
      // A caret with nobody to speak over is just a stray mark.
      if (element.overlap && element.overlap.mode === 'simultaneous') element.overlap = null;
      continue;
    }

    const paren = element.parenthetical || '';

    if (element.overlap && element.overlap.mode) {
      // Already set by the parser from `^`; leave it alone.
    } else if (INTERRUPT_PAREN_REGEX.test(paren)) {
      element.overlap = { mode: 'interrupt', withPrevious: true, offsetMs: null, source: 'parenthetical' };
    } else if (SIMULTANEOUS_PAREN_REGEX.test(paren)) {
      element.overlap = { mode: 'simultaneous', withPrevious: true, offsetMs: null, source: 'parenthetical' };
    } else if (CUT_OFF_END_REGEX.test(prev.text || '')) {
      element.overlap = { mode: 'interrupt', withPrevious: true, offsetMs: null, source: 'dash' };
    } else if (PICK_UP_START_REGEX.test(element.text || '')) {
      element.overlap = { mode: 'interrupt', withPrevious: true, offsetMs: null, source: 'dash' };
    }

    // The victim is marked only when someone actually cuts in. A line ending in
    // a dash that nobody answers is a trailing-off, not an interruption.
    //
    // "The victim" can be several people: when two characters are already
    // talking over each other and a third silences the room, everyone still
    // mid-sentence gets cut off, not just whoever happens to be written last.
    if (element.overlap && element.overlap.mode === 'interrupt') {
      for (const victim of simultaneousClusterEndingAt(elements, i - 1)) {
        if (CUT_OFF_END_REGEX.test(victim.text || '')) victim.cutOff = true;
      }
    }
  }

  // Being cut off changes how a line is *spoken* — it should end unfinished
  // rather than resolve onto a full stop — so the affected lines need their
  // delivery re-read now that the relationship is known.
  for (const element of elements) {
    if (element.type !== 'DIALOGUE') continue;
    const pickUp = PICK_UP_START_REGEX.test(element.text || '');
    if (!element.cutOff && !pickUp) continue;

    const extensionMatch = (element.characterOriginal || '').match(/\([^)]*\)/g);
    element.nuance = analyzeLineNuance({
      text: element.text,
      parenthetical: element.parenthetical || '',
      speakerType: 'CHARACTER',
      extension: extensionMatch ? extensionMatch.join(' ') : '',
      cutOff: element.cutOff,
      pickUp
    });
  }

  return parsed;
}

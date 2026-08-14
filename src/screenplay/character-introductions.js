/**
 * Character introductions — the description a writer gives near a character's
 * first appearance, lifted out of the action so the casting UI can show it.
 *
 *     COMMANDER BRIGGS (50s, towering, heavy combat armor) stands with four
 *     armed security operatives.
 *
 * Someone choosing a voice for BRIGGS wants that sentence far more than they
 * want his line count, and until now it was thrown away: `parsed.characters`
 * carries only the name, the line count, and the first thing the character says.
 *
 * ## This pass never writes to `elements`
 *
 * `hashScript` in `utils/storage.js` folds the `type`, `character`, `text` and
 * `parenthetical` of every element into the per-script storage key. Reclassify
 * one line and every saved cast for every custom script is orphaned. So this
 * reads elements and writes only to `characters`, and the test suite freezes the
 * element array to keep it that way.
 *
 * ## Why it scans text rather than searching for names
 *
 * The obvious implementation runs `text.indexOf(name)` once per cast member.
 * That is O(cast x script) and it matches substrings — KIRA inside KIRAN, a
 * character named AL inside SIGNAL and FINALLY. Instead each action paragraph is
 * tokenized once, maximal runs of all-caps tokens are collected, and each run is
 * looked up in a prebuilt cast index. A whole-token lookup cannot match a
 * substring by construction, and it finds a name mid-line for free.
 *
 * ## The shape gate is what makes this safe
 *
 * Matching a known cast name is necessary but nowhere near sufficient — MOTHER,
 * DOC and GUARD are ordinary cue names that also appear constantly in prose. A
 * match only produces a description when the name is immediately followed by
 * `(` or by `, <age>`. A bare mention — `KIRA leaps across the tiles` — yields
 * nothing, because a plot beat displayed as if it described the character is
 * worse than displaying nothing at all. The casting UI already falls back to the
 * character's first line of dialogue.
 *
 * ## Known limits, deliberately not built
 *
 * - Article-led appositives (`MAYA, a wiry paramedic, kneels...`) are skipped.
 *   Without part-of-speech tagging the right edge is undecidable: nothing
 *   distinguishes the descriptor from the predicate in `MAYA, a paramedic,
 *   kneels beside him, then stands.` The age-led form is decidable because the
 *   age anchors the left edge and the last fragment reliably carries the verb.
 * - A shared introduction (`VALENTINE and KIRA (both 30s, soaked) crouch...`)
 *   attaches to KIRA only.
 * - Forced Fountain cues (`@McCLANE`) never get an introduction, because the
 *   action text writes `McClane`, which is not an all-caps token. That is
 *   correct — the point of a forced cue is that the name is not in caps — but it
 *   looks like a bug from the outside, so: it is not one.
 */

/** Description text is capped so one discursive writer cannot break the card layout. */
const MAX_DESCRIPTION_CHARS = 140;
/** Appositives are looser than parentheticals, so they are held to a tighter cap. */
const MAX_APPOSITIVE_CHARS = 100;
/** An unclosed `(` should fail fast rather than swallow the rest of the scene. */
const MAX_PAREN_SCAN = 400;
/** The verbatim sentence shown when a user expands an introduction. */
const MAX_SOURCE_CHARS = 400;
/** Longest cast name, in tokens, that the run resolver will try to match. */
const MAX_NAME_TOKENS = 5;
/** Longest name span after extension — `CAROL` cued, `CAROL WINTERS` in action. */
const MAX_SPAN_TOKENS = 4;
/** Enough action text to tell a normal script from an all-caps one. */
const CAPS_SAMPLE_CHARS = 20000;
/** Below this share of lowercase letters, the script is written in caps. */
const MIN_LOWERCASE_RATIO = 0.02;

const LOWERCASE_LETTER = /\p{Ll}/u;
const UPPERCASE_LETTER = /\p{Lu}/u;
const LOWERCASE_LETTER_GLOBAL = /\p{Ll}/gu;
const UPPERCASE_LETTER_GLOBAL = /\p{Lu}/gu;

/**
 * Page furniture that lands in the middle of an action paragraph when a PDF
 * breaks across pages. Blanked with equal-length spaces so every offset already
 * computed against the paragraph stays valid.
 */
const PAGE_NOISE_REGEX = /\((?:CONTINUED|MORE|CONT'?D)\)/gi;

/**
 * A cue extension is not a description. These reach the action stream when a
 * parser classifies `KIRA (V.O.) sighs offscreen.` as action, which is the right
 * call — there is no dialogue under it — but it must not become KIRA's portrait.
 */
const CUE_EXTENSION_REGEX =
  /^(?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D\.?|CONTINUED|MORE|BEAT|PRE-?LAP|SUBTITLE|FILTERED|INTO PHONE|ON PHONE)$/i;

/** The cue shape from `fountain-parser.js`, so `J.J.` and `J. J.` index alike. */
const INITIALS_REGEX = /^(?:[A-Z]\.\s*){2,}(?:[A-Z][A-Z0-9_' -]*\.?)?$/;

/**
 * Abbreviations whose period does not end a sentence. Deliberately the same
 * vocabulary the Fountain parser uses to decide whether a trailing period
 * disqualifies a character cue, so the two files agree about what a period means.
 */
const ABBREVIATION_TAIL = /(?:^|\s)(?:[A-Z]|DR|MR|MRS|MS|PROF|CAPT|LT|SGT|GEN|COL|REV|ST|JR|SR)$/i;

/**
 * Age as screenwriters write it. Anchored, so the fragment has to *start* with
 * the age — which is what separates a decidable appositive from a clause.
 */
const AGE_PATTERNS = [
  /^(?:AGED?\s+)?(?:(?:EARLY|MID|LATE)[-\s]?)?\d{1,3}\s*'?S\b/,
  /^(?:AGED?\s+)?(?:(?:EARLY|MID|LATE)[-\s]?)?(?:TEENS|TWENTIES|THIRTIES|FORTIES|FIFTIES|SIXTIES|SEVENTIES|EIGHTIES|NINETIES)\b/,
  /^(?:AGED?\s+)?\d{1,3}$/,
];

/**
 * @typedef {Object} CharacterIntroduction
 * @property {string} text        The writer's description, verbatim.
 * @property {string|null} age    The age fragment as written: '50s', 'mid-40s', '52'.
 * @property {string} sourceText  The whole sentence it came from.
 * @property {string|null} elementId  `element.id` of the action line it started in.
 * @property {'parenthetical'|'appositive'} form  Which shape matched.
 */

/**
 * A token is all-caps if it contains an uppercase letter and no lowercase one.
 * `(50s,` fails on the `s`, which is exactly why a parenthetical never joins the
 * name run in front of it.
 */
function isCapsToken(raw) {
  return UPPERCASE_LETTER.test(raw) && !LOWERCASE_LETTER.test(raw);
}

/**
 * Reduce a token to its comparable core. Periods vanish entirely so `MRS.` and
 * `MRS` are one token and `J.J.` is `JJ`; surrounding punctuation is trimmed so
 * `BRIGGS)` and `ENTRANCE:` compare as bare words.
 */
function normalizeToken(token) {
  return token
    .replace(/\./g, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toUpperCase();
}

/** True when this token's own punctuation closes a sentence. */
function endsSentence(raw) {
  return /[.!?:;]$/.test(raw);
}

/**
 * Offset where a token's name content stops and its punctuation begins. The
 * comma in `MAYA, 32, a paramedic...` belongs to the token, and the shape gate
 * has to see it rather than start reading past it.
 */
function nameEndOf(token) {
  const trimmed = token.raw.replace(/[^\p{L}\p{N}]+$/u, '');
  return token.end - (token.raw.length - trimmed.length);
}

/**
 * A token that could still be part of the name. Anything carrying a bracket, a
 * digit or trailing punctuation has stopped being a name and started being the
 * description — which matters most in a screenplay typed entirely in caps,
 * where `(30S,` is an all-caps token like any other.
 */
function isNameContinuation(raw) {
  return /^[\p{L}][\p{L}'’.-]*$/u.test(raw);
}

/** Page furniture is blanked in place, which leaves runs of spaces behind. */
function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Index every cast name under the forms it might take in action text.
 *
 * @param {Array<{name?: string}>} characters
 * @returns {{index: Map<string, string>, maxNameTokens: number, castSize: number}}
 */
function buildCastIndex(characters) {
  const index = new Map();
  const primaries = new Set();
  let maxNameTokens = 1;

  for (const character of characters) {
    const name = typeof character?.name === 'string' ? character.name.trim() : '';
    if (!name) continue;

    const tokens = name.split(/\s+/).map(normalizeToken).filter(Boolean);
    if (tokens.length === 0) continue;

    const key = tokens.join(' ');
    if (!index.has(key)) index.set(key, name);
    primaries.add(key);
    maxNameTokens = Math.max(maxNameTokens, Math.min(MAX_NAME_TOKENS, tokens.length));

    // `J. J.` tokenizes to two tokens and `J.J.` to one; bridge them. Only for
    // initials — registering every name's tokens joined would let the run
    // `AL AN` resolve to a character called ALAN.
    if (tokens.length > 1 && INITIALS_REGEX.test(name)) {
      const tight = tokens.join('');
      if (!index.has(tight)) index.set(tight, name);
    }
  }

  // A cue of COMMANDER BRIGGS is written BRIGGS half the time. Register the
  // surname, but only where exactly one cast member could mean it — YOUNG SAM
  // and OLD SAM in the same script make SAM useless to everybody.
  const aliasClaims = new Map();
  for (const key of primaries) {
    const tokens = key.split(' ');
    if (tokens.length < 2) continue;
    const alias = tokens[tokens.length - 1];
    if (primaries.has(alias)) continue;
    const owner = index.get(key);
    if (aliasClaims.has(alias) && aliasClaims.get(alias) !== owner) aliasClaims.set(alias, null);
    else if (!aliasClaims.has(alias)) aliasClaims.set(alias, owner);
  }
  for (const [alias, owner] of aliasClaims) {
    if (owner && !index.has(alias)) index.set(alias, owner);
  }

  return { index, maxNameTokens, castSize: new Set(index.values()).size };
}

/**
 * Join consecutive action elements into a paragraph, keeping a map from offset
 * back to the element it came from.
 *
 * This is not an optimization. Both parsers emit one action element per source
 * line — the Fountain parser per physical line, the PDF parser per geometric
 * row — so a hard-wrapped `.fountain` file and every PDF split an introduction
 * across two elements. Scanning elements individually silently fails on those
 * while passing every test written against the bundled samples, whose paragraphs
 * happen to fit on one line.
 */
function buildActionParagraphs(elements) {
  const paragraphs = [];
  let current = null;

  for (const element of elements) {
    if (!element || element.type !== 'ACTION') {
      current = null;
      continue;
    }
    if (current && current.sceneNumber !== element.sceneNumber) current = null;

    const text = typeof element.text === 'string' ? element.text : '';
    if (!current) {
      current = { sceneNumber: element.sceneNumber, text: '', segments: [] };
      paragraphs.push(current);
    }
    if (current.text.length > 0) current.text += ' ';
    const start = current.text.length;
    current.text += text;
    current.segments.push({ start, end: current.text.length, id: element.id });
  }

  for (const paragraph of paragraphs) {
    paragraph.text = paragraph.text.replace(PAGE_NOISE_REGEX, (match) => ' '.repeat(match.length));
  }
  return paragraphs;
}

function elementIdAt(paragraph, offset) {
  for (const segment of paragraph.segments) {
    if (offset >= segment.start && offset < segment.end) return segment.id;
  }
  return paragraph.segments[0]?.id ?? null;
}

/**
 * Offset of the sentence-ending punctuation at or after `from`, or -1.
 * No lookbehind — nothing else in `src/` uses it, and this does not need it.
 */
function findSentenceEnd(text, from) {
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (char !== '.' && char !== '!' && char !== '?') continue;
    if (char === '.' && ABBREVIATION_TAIL.test(text.slice(Math.max(0, i - 6), i))) continue;
    if (i + 1 === text.length || /\s/.test(text[i + 1])) return i;
  }
  return -1;
}

/** The whole sentence a match sits in, for the "in the script" expansion. */
function sentenceAround(text, nameStart, scanFrom) {
  let start = 0;
  let cursor = 0;
  while (cursor < nameStart) {
    const end = findSentenceEnd(text, cursor);
    if (end === -1 || end >= nameStart) break;
    start = end + 1;
    cursor = end + 1;
  }
  while (start < text.length && /\s/.test(text[start])) start++;

  const end = findSentenceEnd(text, scanFrom);
  const stop = end === -1 ? text.length : end + 1;
  return collapseWhitespace(text.slice(start, stop)).slice(0, MAX_SOURCE_CHARS);
}

/** Truncate on a word boundary so a cut never lands mid-word. */
function truncate(value, limit) {
  if (value.length <= limit) return value;
  const clipped = value.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/**
 * The age at the head of a fragment, in the writer's own casing, or null.
 * Every pattern is anchored and digit-bounded, so `1950s` is not an age and
 * neither is a house number.
 */
function extractAge(fragment) {
  const probe = fragment.trim();
  if (!probe) return null;
  const upper = probe.toUpperCase();

  for (const pattern of AGE_PATTERNS) {
    const match = upper.match(pattern);
    if (!match) continue;
    const digits = match[0].match(/\d{1,3}/);
    if (digits) {
      const years = Number(digits[0]);
      if (years < 1 || years > 120) continue;
    }
    return probe.slice(0, match[0].length).trim();
  }
  return null;
}

/**
 * Read a balanced parenthetical starting at `open`.
 * @returns {{body: string, end: number}|null} `end` is the offset after `)`.
 */
function readParenthetical(text, open) {
  const limit = Math.min(text.length, open + MAX_PAREN_SCAN);
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const char = text[i];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return { body: collapseWhitespace(text.slice(open + 1, i)), end: i + 1 };
    }
  }
  return null;
}

/**
 * Decide what, if anything, the text after a resolved name span describes.
 * @returns {{text: string, age: string|null, form: string, scanFrom: number}|null}
 */
function readDescription(text, spanEnd, nameEndsSentence, allowAppositive) {
  let cursor = spanEnd;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  if (cursor >= text.length) return null;

  // `BRIGGS. (A beat.)` — across a joined paragraph the parenthetical belongs to
  // the next sentence, not to BRIGGS.
  if (text[cursor] === '(' && !nameEndsSentence) {
    const parsed = readParenthetical(text, cursor);
    if (!parsed) return null;

    const body = parsed.body;
    if (!body || !/\p{L}/u.test(body)) return null;
    if (CUE_EXTENSION_REGEX.test(body)) return null;

    return {
      text: truncate(body, MAX_DESCRIPTION_CHARS),
      age: extractAge(body.split(',')[0]),
      form: 'parenthetical',
      scanFrom: parsed.end,
    };
  }

  if (text[cursor] === ',' && allowAppositive && !nameEndsSentence) {
    const sentenceEnd = findSentenceEnd(text, cursor);
    const remainder = text.slice(cursor + 1, sentenceEnd === -1 ? text.length : sentenceEnd);
    const fragments = remainder.split(',').map(collapseWhitespace).filter(Boolean);
    if (fragments.length === 0) return null;

    const age = extractAge(fragments[0]);
    if (!age) return null;

    // The last fragment is the predicate — `kneels beside him` — unless the
    // sentence ended before one arrived.
    const kept = (fragments.length > 1 ? fragments.slice(0, -1) : fragments).slice(0, 2);
    const description = kept.join(', ');
    if (!description || description.length > MAX_APPOSITIVE_CHARS) return null;

    return {
      text: description,
      age,
      form: 'appositive',
      scanFrom: sentenceEnd === -1 ? text.length : sentenceEnd,
    };
  }

  return null;
}

/**
 * Find the introduction each character was given in the action.
 *
 * Pure: reads `elements` and `characters`, writes to neither.
 *
 * @param {{elements?: Array, characters?: Array}} parsed
 * @returns {Map<string, CharacterIntroduction>} keyed by `character.name` verbatim
 */
export function findCharacterIntroductions({ elements = [], characters = [] } = {}) {
  const results = new Map();
  if (!Array.isArray(characters) || characters.length === 0) return results;
  if (!Array.isArray(elements) || elements.length === 0) return results;

  const { index, maxNameTokens, castSize } = buildCastIndex(characters);
  if (index.size === 0) return results;

  const paragraphs = buildActionParagraphs(elements);
  if (paragraphs.length === 0) return results;

  // A script typed entirely in caps gives the appositive path no signal to work
  // with — every word looks like a name. The parenthetical path is unaffected,
  // so keep that and drop the other rather than the whole feature.
  let sample = '';
  for (const paragraph of paragraphs) {
    sample += paragraph.text;
    if (sample.length >= CAPS_SAMPLE_CHARS) break;
  }
  sample = sample.slice(0, CAPS_SAMPLE_CHARS);
  const lower = (sample.match(LOWERCASE_LETTER_GLOBAL) || []).length;
  const upper = (sample.match(UPPERCASE_LETTER_GLOBAL) || []).length;
  const allowAppositive = lower + upper === 0 || lower / (lower + upper) >= MIN_LOWERCASE_RATIO;

  let settled = 0;

  for (const paragraph of paragraphs) {
    const text = paragraph.text;
    // Both supported shapes need one of these. Most action lines have neither.
    if (!text.includes('(') && !text.includes(',')) continue;

    const tokens = [];
    for (const match of text.matchAll(/\S+/g)) {
      tokens.push({
        raw: match[0],
        norm: normalizeToken(match[0]),
        start: match.index,
        end: match.index + match[0].length,
        caps: isCapsToken(match[0]),
      });
    }

    let cursor = 0;
    while (cursor < tokens.length) {
      if (!tokens[cursor].caps) {
        cursor++;
        continue;
      }
      let runEnd = cursor;
      while (runEnd < tokens.length && tokens[runEnd].caps) runEnd++;

      let at = cursor;
      while (at < runEnd) {
        let hit = null;
        const longest = Math.min(maxNameTokens, runEnd - at);
        for (let length = longest; length >= 1; length--) {
          const key = tokens
            .slice(at, at + length)
            .map((token) => token.norm)
            .join(' ');
          const name = index.get(key) || (length === 1 ? index.get(key.replace(/\s+/g, '')) : null);
          if (name) {
            hit = { name, length };
            break;
          }
        }
        if (!hit) {
          at++;
          continue;
        }

        // `CAROL` is cued but the action writes `CAROL WINTERS`. Only bare word
        // tokens are absorbed: a token carrying a bracket, a digit or trailing
        // punctuation is where the name stopped and the description started.
        let spanEnd = at + hit.length;
        while (
          spanEnd < runEnd &&
          spanEnd - at < MAX_SPAN_TOKENS &&
          isNameContinuation(tokens[spanEnd - 1].raw) &&
          isNameContinuation(tokens[spanEnd].raw) &&
          !index.has(tokens[spanEnd].norm)
        ) {
          spanEnd++;
        }

        const lastToken = tokens[spanEnd - 1];
        const described = readDescription(text, nameEndOf(lastToken), endsSentence(lastToken.raw), allowAppositive);

        if (described) {
          const existing = results.get(hit.name);
          // First described mention wins, except that a parenthetical is the
          // introduction and an appositive later in the script is a recap.
          if (!existing || (existing.form === 'appositive' && described.form === 'parenthetical')) {
            if (described.form === 'parenthetical' && existing?.form !== 'parenthetical') settled++;
            results.set(hit.name, {
              text: described.text,
              age: described.age,
              sourceText: sentenceAround(text, tokens[at].start, described.scanFrom),
              elementId: elementIdAt(paragraph, tokens[at].start),
              form: described.form,
            });
          }
        }

        at = spanEnd;
      }
      cursor = runEnd;
    }

    if (settled >= castSize) break;
  }

  return results;
}

/**
 * Set `introduction` on every entry of `parsed.characters` — the object above,
 * or null when the script never described them. Always defined, so consumers
 * never have to tell "missing" from "not found".
 *
 * Idempotent, and it does not touch `parsed.elements`.
 *
 * @param {Object} parsed
 * @returns {Object} the same object
 */
export function attachCharacterIntroductions(parsed) {
  if (!parsed || !Array.isArray(parsed.characters)) return parsed;

  const found = findCharacterIntroductions(parsed);
  for (const character of parsed.characters) {
    if (character) character.introduction = found.get(character.name) || null;
  }
  return parsed;
}

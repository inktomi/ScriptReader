/**
 * A character's sex, read off how the script talks about them.
 *
 * Casting used to answer this from the character's name and, when the script
 * described them, from their introduction. Both run out fast. A first name
 * carries no reliable signal — Lee, Perri, Taryn and Cici are women in
 * `Midnight Caravan` and none of them is a name a list would have — and an
 * introduction only helps for the characters who get one. On that script the
 * name-and-introduction path placed seven of twelve speaking roles in the wrong
 * sex, every miss in the same direction, because male is the fallback.
 *
 * The script answers it anyway, just not where casting was looking. Action
 * lines refer to characters by pronoun constantly: `LEE VALMONT (22) — sits at
 * her desk`, `She flips a switch`. Counting those across the whole screenplay
 * and attributing each to the character most recently named is enough to settle
 * most of a cast, and it needs no list of names.
 *
 * Attribution is recency-based and therefore not perfect — `Lee looks at Jay.
 * She turns away.` credits Jay. That is why this reports a verdict only on a
 * clear majority over a meaningful sample, and reports nothing otherwise: a
 * character the script never leans one way about falls back to the existing
 * name and introduction logic rather than being decided by noise.
 */

const FEMALE_PRONOUNS = new Set(['SHE', 'HER', 'HERS', 'HERSELF']);
const MALE_PRONOUNS = new Set(['HE', 'HIM', 'HIS', 'HIMSELF']);

/**
 * Nouns that name a person's sex outright when they appear in prose.
 *
 * Kept here rather than in voice-catalog.js because that list does a different
 * job — it also holds first names, for matching a cue like SARAH — and because
 * this one is consumed by the screenplay parsers, which should not reach into
 * the audio layer for it.
 */
const GENDERED_NOUNS =
  /\b(?:wom[ae]n|girls?|ladies|lady|mothers?|daughters?|sisters?|wi(?:fe|ves)|aunts?|nieces?|widows?|queens?|princess(?:es)?|actress(?:es)?|waitress(?:es)?|matriarchs?|grandmothers?|men|man|boys?|gentlemen|gentleman|fathers?|sons?|brothers?|husbands?|uncles?|nephews?|widowers?|kings?|princes?|grandfathers?)\b/i;

/** True when a fragment of prose names someone's sex outright. */
export function containsGenderedNoun(text) {
  return GENDERED_NOUNS.test(String(text || ''));
}

/**
 * How many consecutive action elements that name nobody may still be credited
 * to the last character named. One keeps `Lee closes the email.` / `She flips a
 * switch.` together — they are separate elements — without letting a subject
 * drift down a page of description about somebody else.
 */
const CARRY_ELEMENTS = 1;

/** Below this many attributed pronouns the sample is too small to trust. */
const MIN_PRONOUNS = 4;

/** How far the majority must lead before the count is called a verdict. */
const MAJORITY_RATIO = 2;

/** Cue names indexed by their first word, which is how action lines name them. */
function buildNameIndex(characters) {
  const byToken = new Map();
  for (const character of characters) {
    const token = String(character?.name || '')
      .toUpperCase()
      .trim()
      .split(/[^A-Z0-9]+/)
      .filter(Boolean)[0];
    // First cue wins, so `LEE` maps to LEE rather than to a later LEE'S CREW.
    if (token && !byToken.has(token)) byToken.set(token, character.name);
  }
  return byToken;
}

/**
 * Pronoun counts per character. Exported for tests and for anyone wanting to
 * see the evidence behind a verdict rather than just the verdict.
 */
export function tallyGenderPronouns({ elements = [], characters = [] } = {}) {
  const byToken = buildNameIndex(characters);
  const tally = new Map();
  if (byToken.size === 0) return tally;

  const bump = (name, key) => {
    if (!name) return;
    if (!tally.has(name)) tally.set(name, { female: 0, male: 0 });
    tally.get(name)[key]++;
  };

  let current = null;
  let unnamedElements = 0;

  for (const element of elements) {
    // A new scene is a new context; carrying a subject across the cut is how a
    // subject ends up credited with a different scene's pronouns.
    if (element?.type === 'SCENE_HEADING') {
      current = null;
      continue;
    }
    // The speaker is a strong antecedent for the action that follows them.
    if (element?.type === 'DIALOGUE') {
      const speaker = byToken.get(
        String(element.character || '')
          .toUpperCase()
          .split(/[^A-Z0-9]+/)
          .filter(Boolean)[0],
      );
      if (speaker) {
        current = speaker;
        unnamedElements = 0;
      }
      continue;
    }
    if (element?.type !== 'ACTION') continue;

    let named = false;
    // Apostrophes stay inside words so `LEE'S` still reads as LEE.
    for (const word of String(element.text || '').split(/[^A-Za-z0-9’']+/)) {
      if (!word) continue;
      const upper = word.toUpperCase();
      const match = byToken.get(upper) || byToken.get(upper.replace(/[’']S$/, ''));
      if (match) {
        current = match;
        unnamedElements = 0;
        named = true;
        continue;
      }
      if (unnamedElements > CARRY_ELEMENTS) continue;
      if (FEMALE_PRONOUNS.has(upper)) bump(current, 'female');
      else if (MALE_PRONOUNS.has(upper)) bump(current, 'male');
    }
    if (!named) unnamedElements++;
  }

  return tally;
}

/** 'Female', 'Male', or null when the script does not lean clearly either way. */
export function genderFromTally(counts) {
  const female = counts?.female || 0;
  const male = counts?.male || 0;
  if (female + male < MIN_PRONOUNS) return null;
  if (female >= male * MAJORITY_RATIO) return 'Female';
  if (male >= female * MAJORITY_RATIO) return 'Male';
  return null;
}

export function inferCharacterGender(parsed) {
  const tally = tallyGenderPronouns(parsed || {});
  const result = new Map();
  for (const [name, counts] of tally) {
    const gender = genderFromTally(counts);
    if (gender) result.set(name, gender);
  }
  return result;
}

/**
 * Set `gender` on every entry of `parsed.characters` — 'Female', 'Male', or
 * null where the script gave no clear signal. Always defined, so casting never
 * has to tell "missing" from "not found", and idempotent.
 */
export function attachCharacterGender(parsed) {
  if (!parsed || !Array.isArray(parsed.characters)) return parsed;
  const found = inferCharacterGender(parsed);
  for (const character of parsed.characters) {
    if (character) character.gender = found.get(character.name) || null;
  }
  return parsed;
}

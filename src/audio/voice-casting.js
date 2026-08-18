/**
 * Matching a role to a voice by what the script says and what the voice is.
 *
 * The Kokoro path in voice-catalog.js has always done this, against a curated
 * list of 25 voices with hand-written traits. The cloning engines could not:
 * `mapVoiceAcrossEngines` hands Chatterbox "the first voice in the library
 * nobody else took", so a sixty-year-old villain got whatever the writer
 * happened to import third. That was not an oversight so much as a consequence
 * — a cloned voice had no traits to match on.
 *
 * It does now. A voice imported from the bundled catalog carries the reader's
 * recorded sex, the age band and accent from the annotation sets, and the
 * measured pitch register, so the same intent the Kokoro shortlist expresses can
 * be applied to 1,150 voices.
 */

import { ENGINE_IDS } from './engine-contract.js';
import { characterCastingTraits, getVoicesForEngine, mapVoiceAcrossEngines } from './voice-catalog.js';

/**
 * Character age in years -> the catalog's perceptual band.
 *
 * Deliberately not the same cut points as `pickShortlist`, which treats <=19 as
 * young and >=60 as elder. That list is choosing between a handful of curated
 * voices where "young" has to mean unmistakably young to be worth spending one
 * of three slots on. Here the bands partition the whole catalog, so every age
 * has to land somewhere, and a thirty-year-old should not be filed next to a
 * seventy-year-old just because neither is a teenager.
 */
export function ageBandForYears(years) {
  if (typeof years !== 'number' || Number.isNaN(years)) return null;
  if (years < 30) return 'young';
  if (years < 55) return 'adult';
  return 'senior';
}

/**
 * Words a writer puts in an introduction that name an accent the catalog can
 * actually answer. Keyed by the catalog's own spelling so a hit is usable as a
 * filter value without translation.
 */
const ACCENT_HINTS = {
  American: ['AMERICAN', 'YANK'],
  English: ['BRITISH', 'ENGLISH', 'LONDONER', 'COCKNEY', 'DUCHESS', 'DUKE', 'EARL', 'BUTLER', 'VICAR'],
  Scottish: ['SCOTTISH', 'SCOT', 'SCOTS', 'GLASWEGIAN'],
  Irish: ['IRISH', 'DUBLINER'],
  Welsh: ['WELSH'],
  Australian: ['AUSTRALIAN', 'AUSSIE'],
  Canadian: ['CANADIAN'],
  Indian: ['INDIAN'],
  German: ['GERMAN'],
  French: ['FRENCH'],
  Dutch: ['DUTCH'],
  Chinese: ['CHINESE'],
  'New zealand': ['ZEALANDER', 'KIWI'],
};

/** The accent the introduction names, or '' when it names none. */
export function accentHintFrom(tokens = []) {
  for (const [accent, words] of Object.entries(ACCENT_HINTS)) {
    if (words.some((word) => tokens.includes(word))) return accent;
  }
  return '';
}

/**
 * A voice's traits, however that voice reached us. A bundled catalog entry and
 * a stored Studio voice describe the same three things under different field
 * names, and the store's placeholders for "not recorded" have to read as absent
 * rather than as a value to match against.
 */
export function voiceTraits(voice) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const sex = text(voice?.gender) || text(voice?.sex);
  const ageLabel = text(voice?.ageLabel) || text(voice?.ageGroup);
  const accent = text(voice?.accent);
  const register = text(voice?.register);
  return {
    sex,
    // 'Reference performance' and 'Cloned' are what chatterbox-voice-store falls
    // back to for a voice with no sourced trait. They are labels, not traits.
    ageBand: /^(young|adult|senior)$/i.test(ageLabel) ? ageLabel.toLowerCase() : '',
    accent: accent && accent !== 'Unspecified' && accent !== 'Cloned' ? accent : '',
    register,
  };
}

const SEX_MISMATCH = -1;

/**
 * How well a voice suits a role. Higher is better; SEX_MISMATCH means never.
 *
 * Sex is a veto rather than a weight because casting a man's line in a woman's
 * voice is not a near miss, it is the wrong take. Everything below it is
 * additive, and a voice missing a trait scores zero for it rather than being
 * penalised — an unannotated reader should lose to a matching one and beat a
 * contradicting one.
 */
export function scoreVoiceForRole(voice, traits, { usedRegisters = new Set() } = {}) {
  const { sex, ageBand, accent, register } = voiceTraits(voice);
  const wantSex = traits.isFemale ? 'Female' : 'Male';
  if (sex && sex !== wantSex) return SEX_MISMATCH;

  let score = 0;
  if (sex === wantSex) score += 100;

  // Age is penalised as heavily as it is rewarded. "Sounds seventy" and "sounds
  // twenty" are opposite takes, not neighbouring ones, and an asymmetric penalty
  // let a matching accent buy back a contradicting age — which cast a young
  // Irish voice as a seventy-year-old Irish matriarch.
  const wantAge = ageBandForYears(traits.years);
  if (wantAge && ageBand) score += ageBand === wantAge ? 40 : -40;

  // Accent is worth less both ways. It is a smaller perceptual distance than
  // age, and the catalog's accents are concentrated enough that insisting on
  // one would empty the pool for most roles.
  const wantAccent = accentHintFrom(traits.tokens);
  if (wantAccent && accent) score += accent === wantAccent ? 25 : -10;

  // Ensemble contrast. Two clean recordings in the same register are harder to
  // tell apart in a readthrough than one clean and one merely good, and telling
  // characters apart is the whole point of casting them separately.
  if (register && usedRegisters.has(register)) score -= 25;

  // Clarity breaks ties, on the same measured SNR the catalog ranks by.
  score += Math.min(20, Number(voice?.snrDb) || 0) / 10;
  return score;
}

/**
 * Best unused voice in `pool` for a role, or null when the pool cannot serve it.
 * `used` is mutated by the caller between calls, which is what keeps an ensemble
 * from collapsing onto one voice.
 */
export function pickVoiceForRole(pool, traits, { used = new Set(), byId = null } = {}) {
  const lookup = byId || new Map(pool.map((voice) => [voice.id, voice]));
  const usedRegisters = new Set();
  for (const id of used) {
    const register = voiceTraits(lookup.get(id) || {}).register;
    if (register) usedRegisters.add(register);
  }

  let best = null;
  let bestScore = SEX_MISMATCH;
  for (const voice of pool) {
    if (used.has(voice.id)) continue;
    const score = scoreVoiceForRole(voice, traits, { usedRegisters });
    if (score === SEX_MISMATCH || score <= bestScore) continue;
    best = voice;
    bestScore = score;
  }
  return best;
}

/**
 * Cast every role from `pool` in one pass.
 *
 * Characters arrive sorted by line count (both parsers do this), so the biggest
 * parts pick first and get the closest match rather than the leftovers. A role
 * the pool cannot serve is left out of the result instead of being handed a
 * wrong-sex voice; the caller decides what to do about a gap it can see.
 */
export function castRoles(characters = [], pool = [], { reserved = [] } = {}) {
  const byId = new Map(pool.map((voice) => [voice.id, voice]));
  const used = new Set(reserved);
  const cast = new Map();

  for (const character of characters) {
    const traits = characterCastingTraits(character.name, {
      introduction: character.introduction,
      gender: character.gender,
      sampleLine: character.sampleLine,
    });
    if (traits.isNarrator) continue;
    const voice = pickVoiceForRole(pool, traits, { used, byId });
    if (!voice) continue;
    used.add(voice.id);
    cast.set(traits.name, voice);
  }
  return cast;
}

/**
 * The engine voice a character should get, for the engines whose pool is the
 * writer's own cloned library.
 *
 * Falls back to `mapVoiceAcrossEngines` whenever trait matching has nothing to
 * work with — a pool of private uploads, or a role the pool cannot serve. That
 * fallback is the old behaviour, so a library with no sourced traits casts
 * exactly as it did before rather than differently and worse.
 */
export function pickEngineVoiceForCharacter(
  characterName,
  { introduction, gender, sampleLine, engineId, usedVoices = new Set(), fallbackVoiceId = '' } = {},
) {
  const clonesOwnPool = engineId === ENGINE_IDS.CHATTERBOX || engineId === ENGINE_IDS.RUNPOD;
  if (clonesOwnPool) {
    const traits = characterCastingTraits(characterName, { introduction, gender, sampleLine });
    if (!traits.isNarrator) {
      const matched = pickVoiceForRole(getVoicesForEngine(engineId), traits, { used: usedVoices });
      if (matched) return matched.id;
    }
  }
  return mapVoiceAcrossEngines(fallbackVoiceId, engineId, usedVoices);
}

/**
 * The filters the catalog browser should open with for a role — the search the
 * writer would otherwise have to reconstruct by hand from an introduction the
 * app already parsed.
 *
 * Age is left blank when the script never said one. Guessing a band from a name
 * would narrow the catalog on nothing, and an empty result reads as "no such
 * voice" rather than "you were never asked".
 */
export function catalogFiltersForRole(characterName, context = {}) {
  const traits = characterCastingTraits(characterName, context);
  const age = ageBandForYears(traits.years);
  return {
    query: '',
    gender: traits.isFemale ? 'female' : 'male',
    age: age || '',
    accent: accentHintFrom(traits.tokens),
    register: '',
    pace: '',
  };
}

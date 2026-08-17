import { readBoundedResponseBlob } from '../utils/bounded-response.js';

// The catalog ships with the app. It used to be a live search against
// ElevenLabs' shared-voices endpoint, which now answers anonymous callers with
// 401 "You must be logged in to use filters" — every request the browser made
// was rejected, not just the ones carrying a search term. Rather than put an
// account or a proxied API key in front of casting, the voices are built from
// LibriTTS-R (CC BY 4.0) by scripts/build-voice-catalog.mjs and served from our
// own origin, so search is offline, unmetered, and cannot be revoked upstream.
const CATALOG_PATH = 'voice-samples/catalog.json';
const DEFAULT_PAGE_SIZE = 24;
const MAX_SAMPLE_BYTES = 25 * 1024 * 1024;

/**
 * Band lookups are also membership tests — `LABELS[band] ? band : fallback` is
 * how a malformed catalog entry gets rejected. A plain object literal inherits
 * Object.prototype, so `"constructor"` and `"toString"` would pass that test and
 * put a function where a label belongs. A null prototype makes the lookup mean
 * only what the map declares.
 */
function lookup(map) {
  return Object.assign(Object.create(null), map);
}

const REGISTER_LABELS = lookup({
  deep: 'Deep',
  low: 'Low',
  mid: 'Mid',
  bright: 'Bright',
  high: 'High',
  unmeasured: 'Unmeasured',
});

const PACE_LABELS = lookup({
  measured: 'Measured pace',
  steady: 'Steady pace',
  brisk: 'Brisk pace',
});

// Bands assigned by scripts/voice-trait-bands.mjs from the LibriTTS-P speaker
// annotations. `unspecified` is a real value, not a placeholder: four readers
// are outside the annotation set, and folding them into `adult` would state
// something nobody recorded.
const AGE_LABELS = lookup({
  young: 'Young',
  adult: 'Adult',
  senior: 'Senior',
  unspecified: 'Unspecified',
});

export const UNSPECIFIED_ACCENT = 'Unspecified';

// Words a director actually types, mapped onto the axes the catalog can
// honestly answer. Anything outside this list falls through to plain text
// matching rather than being silently reinterpreted.
const REGISTER_SYNONYMS = lookup({
  deep: ['deep', 'bass', 'gravelly', 'low', 'dark', 'booming', 'baritone'],
  low: ['low', 'warm', 'rich', 'baritone', 'husky'],
  mid: ['mid', 'middle', 'neutral', 'even', 'natural'],
  bright: ['bright', 'light', 'clear', 'lifted'],
  high: ['high', 'bright', 'airy', 'young', 'light'],
});

const PACE_SYNONYMS = lookup({
  measured: ['measured', 'slow', 'deliberate', 'calm', 'unhurried', 'steady'],
  steady: ['steady', 'even', 'natural', 'conversational'],
  brisk: ['brisk', 'fast', 'quick', 'urgent', 'energetic', 'lively'],
});

const AGE_SYNONYMS = lookup({
  young: ['young', 'younger', 'youthful', 'juvenile'],
  adult: ['adult', 'middle', 'grown'],
  senior: ['senior', 'old', 'older', 'elderly', 'aged', 'mature', 'veteran'],
});

// The catalog's accent values are single words apart from two, so the tokeniser
// needs the second word of each to be matchable on its own — nobody types "new
// zealand" and expects "zealand" to be the part that fails.
const ACCENT_SYNONYMS = lookup({
  American: ['american', 'america', 'us', 'usa'],
  Canadian: ['canadian', 'canada'],
  Irish: ['irish', 'ireland'],
  'New zealand': ['new', 'zealand', 'kiwi'],
  English: ['english', 'england', 'british', 'britain', 'uk'],
  Scottish: ['scottish', 'scotland', 'scots'],
  Chinese: ['chinese', 'china'],
  German: ['german', 'germany'],
  Australian: ['australian', 'australia', 'aussie'],
  Indian: ['indian', 'india'],
  Welsh: ['welsh', 'wales'],
  French: ['french', 'france'],
  'Latin american': ['latin', 'american', 'latino'],
  Dutch: ['dutch', 'netherlands', 'holland'],
});

function clean(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function assetBase() {
  // Vite serves public/ from BASE_URL; the fallback keeps this importable from
  // Node's test runner, where import.meta.env does not exist.
  const base = import.meta.env?.BASE_URL || '/';
  return base.endsWith('/') ? base : `${base}/`;
}

export function voiceSampleAssetUrl(file) {
  // An entry with no clip must resolve to nothing, not to the directory it
  // would have lived in — that URL exists and would be fetched as audio.
  const name = clean(file);
  return name ? `${assetBase()}voice-samples/${name}` : '';
}

/**
 * A statement about the recording, not about the speaker. Signal-to-noise is
 * measured off the shipped clip at build time, so a label here is reproducible
 * rather than an opinion.
 */
export function voiceSampleQualityLabel(voice) {
  const snr = Number(voice?.snrDb || 0);
  if (snr >= 36) return 'Pristine capture';
  if (snr >= 30) return 'Studio clean';
  if (snr >= 25) return 'Clean capture';
  return 'Good capture';
}

/**
 * Ranking signal. Cleaner recordings clone better than noisy ones, and a longer
 * reference gives the cloner more prosody to work from, so both feed the sort
 * with clarity dominating.
 */
export function voiceSampleQualityScore(voice) {
  const snr = Math.min(45, Number(voice?.snrDb || 0));
  const seconds = Math.min(12, Number(voice?.seconds || 0));
  return snr * 2 + seconds;
}

export function normalizeCatalogVoice(entry, catalog = {}) {
  const register = clean(entry?.register, 'unmeasured');
  const pace = clean(entry?.pace, 'steady');
  const ageBand = clean(entry?.ageBand, 'unspecified');
  const accent = clean(entry?.accent, UNSPECIFIED_ACCENT);
  const pitchHz = Number(entry?.pitchHz) || null;
  const wpm = Number(entry?.wordsPerMinute) || 0;
  const name = clean(entry?.name, 'Untitled voice');
  // Every clause below is sourced: the reader's name and gender from the corpus
  // speaker table, pitch and pace from the shipped clip, age and accent from the
  // annotation sets credited in ATTRIBUTION.md. Nothing is inferred from the
  // audio, and a trait no source records is left off the card entirely rather
  // than guessed for a real person who volunteered a reading.
  const sentences = [`Audiobook narration read by ${name}.`];
  const traits = [ageBand !== 'unspecified' ? AGE_LABELS[ageBand] : '', accent !== UNSPECIFIED_ACCENT ? accent : ''];
  if (traits.some(Boolean)) sentences.push(`${traits.filter(Boolean).join(', ')}.`);
  const measured = [pitchHz ? `median pitch ${pitchHz} Hz` : '', wpm ? `${wpm} words per minute` : ''];
  if (measured.some(Boolean)) {
    const joined = measured.filter(Boolean).join(', ');
    sentences.push(`${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`);
  }

  const voice = {
    id: clean(entry?.id),
    name,
    gender: clean(entry?.gender, 'Neutral'),
    // Empty unless the annotators heard the recording as the opposite of what
    // the corpus records, which is the only case worth putting on a card.
    perceivedGender: clean(entry?.perceivedGender),
    ageBand: AGE_LABELS[ageBand] ? ageBand : 'unspecified',
    ageLabel: AGE_LABELS[ageBand] || AGE_LABELS.unspecified,
    accent,
    register,
    registerLabel: REGISTER_LABELS[register] || REGISTER_LABELS.unmeasured,
    pace,
    paceLabel: PACE_LABELS[pace] || PACE_LABELS.steady,
    pitchHz,
    wordsPerMinute: wpm,
    seconds: Number(entry?.seconds) || 0,
    snrDb: Number(entry?.snrDb) || 0,
    description: sentences.join(' '),
    source: clean(catalog.source, 'LibriTTS-R'),
    license: clean(catalog.license, 'CC BY 4.0'),
    previewUrl: voiceSampleAssetUrl(clean(entry?.clip)),
  };
  voice.qualityLabel = voiceSampleQualityLabel(voice);
  voice.qualityScore = voiceSampleQualityScore(voice);
  return voice;
}

let catalogPromise = null;

export function resetVoiceSampleCatalog() {
  catalogPromise = null;
}

/**
 * Deliberately takes no abort signal. The load is shared by every caller, so
 * binding it to the first one means a superseded search — the modal aborts the
 * previous one on each keystroke — would reject the load for whoever replaced
 * it. Callers cancel by ignoring the result, which is what they do anyway; the
 * asset is small, same-origin, and fetched once per session.
 */
export async function loadVoiceSampleCatalog({ fetchImpl = globalThis.fetch } = {}) {
  if (catalogPromise) return catalogPromise;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Voice search is unavailable in this browser.');
  }

  catalogPromise = (async () => {
    let payload;
    try {
      // `no-cache` means revalidate, not "don't cache": the browser still keeps
      // the file and the server answers 304 with no body when it is unchanged.
      // Without it a returning visitor pairs a fresh content-hashed bundle with
      // whatever catalog.json they cached last time, and the mismatch is silent
      // — a catalog missing a field the new code filters on returns zero
      // matches rather than an error. The clips keep their long cache; this is
      // one small conditional request per session for the manifest that has to
      // agree with the code reading it.
      const response = await fetchImpl(`${assetBase()}${CATALOG_PATH}`, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`status ${response.status}`);
      payload = await response.json();
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new Error(
        error instanceof SyntaxError
          ? 'The voice catalog file is unreadable. Reinstall or rebuild the app.'
          : 'The voice catalog could not be loaded.',
      );
    }
    const voices = (Array.isArray(payload?.voices) ? payload.voices : [])
      .map((entry) => normalizeCatalogVoice(entry, payload))
      .filter((voice) => voice.id && voice.previewUrl);
    return { ...payload, voices };
  })();

  try {
    return await catalogPromise;
  } catch (error) {
    // A failed load must not poison every later attempt; the next open retries.
    catalogPromise = null;
    throw error;
  }
}

function tokensOf(query) {
  return clean(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A token matches when it names something the catalog actually knows: the
 * reader, the gender, the age band, the accent, or one of the two measured
 * axes. Unknown words still have to match somewhere, so a search for a trait we
 * do not record returns nothing instead of quietly returning everything.
 *
 * A voice whose age or accent is `unspecified` matches no term for either, so
 * an unannotated reader never answers to a request the catalog cannot verify
 * for them.
 */
function matchesToken(voice, token) {
  if (voice.name.toLowerCase().includes(token)) return true;
  if (voice.gender.toLowerCase() === token) return true;
  if ((token === 'man' || token === 'men') && voice.gender === 'Male') return true;
  if ((token === 'woman' || token === 'women') && voice.gender === 'Female') return true;
  if (AGE_SYNONYMS[voice.ageBand]?.includes(token)) return true;
  if (ACCENT_SYNONYMS[voice.accent]?.includes(token)) return true;
  if (voice.accent !== UNSPECIFIED_ACCENT && voice.accent.toLowerCase().includes(token)) return true;
  if (REGISTER_SYNONYMS[voice.register]?.includes(token)) return true;
  if (PACE_SYNONYMS[voice.pace]?.includes(token)) return true;
  return false;
}

export function matchesVoiceFilters(voice, filters = {}) {
  const gender = clean(filters.gender).toLowerCase();
  if (gender && voice.gender.toLowerCase() !== gender) return false;

  // Age and accent are selected by their exact stored value, `unspecified`
  // included: a reader the annotation sets do not cover has to stay reachable,
  // or the filter would hide voices without ever saying so.
  const age = clean(filters.age).toLowerCase();
  if (age && voice.ageBand !== age) return false;

  const accent = clean(filters.accent);
  if (accent && voice.accent.toLowerCase() !== accent.toLowerCase()) return false;

  const register = clean(filters.register).toLowerCase();
  if (register && voice.register !== register) return false;

  const pace = clean(filters.pace).toLowerCase();
  if (pace && voice.pace !== pace) return false;

  const tokens = tokensOf(filters.query);
  return tokens.every((token) => matchesToken(voice, token));
}

export async function searchVoiceSamples(filters = {}, { signal, fetchImpl = globalThis.fetch } = {}) {
  const catalog = await loadVoiceSampleCatalog({ fetchImpl });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const pageSize = Math.max(1, Math.min(200, Number(filters.pageSize) || DEFAULT_PAGE_SIZE));
  const page = Math.max(0, Number(filters.page) || 0);

  const matched = catalog.voices
    .filter((voice) => matchesVoiceFilters(voice, filters))
    .sort((a, b) => b.qualityScore - a.qualityScore || a.name.localeCompare(b.name));

  const start = page * pageSize;
  return {
    voices: matched.slice(start, start + pageSize),
    hasMore: matched.length > start + pageSize,
    totalCount: matched.length,
    page,
    // The accent list is built at catalog build time from the values actually
    // present, so the filter can only ever offer choices that exist. It rides
    // along with the search rather than needing its own load.
    accents: Array.isArray(catalog.accents) ? catalog.accents : [],
  };
}

function safeFileName(name) {
  const base = clean(name, 'catalog-voice')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'catalog-voice'}.mp3`;
}

export async function downloadVoiceSample(voice, { signal, fetchImpl = globalThis.fetch } = {}) {
  const url = clean(voice?.previewUrl);
  // Same-origin now, but the bound stays: it is what stops a corrupted or
  // swapped asset from being read into memory unchecked.
  if (!url) throw new Error('This voice does not have a downloadable preview.');

  let response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('The voice sample could not be loaded.');
  }

  if (!response.ok) throw new Error('The voice sample could not be loaded.');
  const contentType = response.headers?.get?.('content-type') || 'audio/mpeg';
  const blob = await readBoundedResponseBlob(response, {
    maxBytes: MAX_SAMPLE_BYTES,
    signal,
    contentType,
    tooLargeError: () => new Error('That voice sample is too large to import.'),
    unsafeFallbackError: () => new Error('This browser cannot safely load that voice sample.'),
  });
  if (!blob.size) throw new Error('The voice sample was empty.');

  return new File([blob], safeFileName(voice.name), {
    type: blob.type || contentType,
    lastModified: Date.now(),
  });
}

export const VOICE_SAMPLE_CATALOG = Object.freeze({
  provider: 'LibriTTS-R',
  providerUrl: 'https://www.openslr.org/141/',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  pageSize: DEFAULT_PAGE_SIZE,
  registers: Object.keys(REGISTER_LABELS).filter((key) => key !== 'unmeasured'),
  paces: Object.keys(PACE_LABELS),
  // `unspecified` stays in the list. Four readers sit outside the annotation
  // sets, and a filter that cannot reach them would drop voices silently.
  ages: Object.keys(AGE_LABELS),
  ageLabels: AGE_LABELS,
});

import { readBoundedResponseBlob } from '../utils/bounded-response.js';

const SHARED_VOICES_ENDPOINT = 'https://api.elevenlabs.io/v1/shared-voices';
const DEFAULT_PAGE_SIZE = 24;
const MAX_SAMPLE_BYTES = 25 * 1024 * 1024;

function clean(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function titleCase(value, fallback = '') {
  const text = clean(value, fallback).replace(/[_-]+/g, ' ');
  return text.replace(/\b\w/g, letter => letter.toUpperCase());
}

function normalizedGender(value) {
  const gender = clean(value, 'Neutral').toLowerCase();
  if (gender === 'female') return 'Female';
  if (gender === 'male') return 'Male';
  // Casting currently exposes three groups. Preserve every catalog voice by
  // putting provider-specific and non-binary labels in the neutral group
  // instead of saving a voice that no selector can display.
  return 'Neutral';
}

function normalizedAge(value) {
  const age = clean(value, 'Adult').toLowerCase().replace(/[ -]+/g, '_');
  const labels = {
    young: 'Young adult',
    young_adult: 'Young adult',
    middle_aged: 'Middle-aged',
    middle_age: 'Middle-aged',
    old: 'Older adult',
    senior: 'Older adult'
  };
  return labels[age] || titleCase(age, 'Adult');
}

function verifiedLanguageCount(voice) {
  return Array.isArray(voice.verifiedLanguages) ? voice.verifiedLanguages.length : 0;
}

/**
 * A quality signal, not a claim about fidelity. Library category and verified
 * language previews come first; real usage breaks ties because those voices
 * have survived more auditions than a newly-uploaded sample.
 */
export function voiceSampleQualityScore(voice) {
  const category = clean(voice.category).toLowerCase();
  const categoryScore = category === 'high_quality' ? 50
    : category === 'professional' ? 35
      : category === 'famous' ? 20 : 0;
  const verifiedScore = Math.min(15, verifiedLanguageCount(voice) * 5);
  const usageScore = Math.min(25, Math.log10(1 + Number(voice.usageCount || 0)) * 5);
  const adoptionScore = Math.min(10, Math.log10(1 + Number(voice.clonedByCount || 0)) * 3);
  return categoryScore + verifiedScore + usageScore + adoptionScore;
}

export function voiceSampleQualityLabel(voice) {
  const category = clean(voice.category).toLowerCase();
  if (category === 'high_quality') return 'Highest quality';
  if (verifiedLanguageCount(voice) > 0) return 'Verified professional';
  if (category === 'professional') return 'Professional';
  return 'Community';
}

export function normalizeSharedVoice(item, preferredLanguage = '') {
  const verifiedLanguages = Array.isArray(item?.verified_languages)
    ? item.verified_languages.map(entry => ({
      language: clean(entry?.language),
      locale: clean(entry?.locale),
      accent: titleCase(entry?.accent),
      previewUrl: clean(entry?.preview_url)
    })).filter(entry => entry.language || entry.previewUrl)
    : [];
  const requestedLanguage = clean(preferredLanguage).toLowerCase();
  const matchingVerified = verifiedLanguages.find(entry => (
    entry.language.toLowerCase() === requestedLanguage
    || entry.locale.toLowerCase().startsWith(`${requestedLanguage}-`)
  ));
  const topLevelMatches = clean(item?.language).toLowerCase() === requestedLanguage
    || clean(item?.locale).toLowerCase().startsWith(`${requestedLanguage}-`);
  const primaryVerified = matchingVerified || (topLevelMatches ? {} : verifiedLanguages[0]) || {};
  const descriptive = titleCase(item?.descriptive);
  const description = clean(item?.description, descriptive || 'Natural character voice');

  const voice = {
    id: clean(item?.voice_id),
    ownerId: clean(item?.public_owner_id),
    name: clean(item?.name, 'Untitled voice'),
    gender: normalizedGender(item?.gender),
    age: normalizedAge(item?.age),
    accent: titleCase(primaryVerified.accent || item?.accent, 'Unspecified accent'),
    language: clean(primaryVerified.language || requestedLanguage || item?.language, 'en').toLowerCase(),
    locale: clean(primaryVerified.locale || item?.locale),
    descriptive,
    description,
    useCase: titleCase(item?.use_case, 'Character performance'),
    category: clean(item?.category, 'professional').toLowerCase(),
    previewUrl: clean(primaryVerified.previewUrl || item?.preview_url),
    usageCount: Number(item?.usage_character_count_1y || 0),
    clonedByCount: Number(item?.cloned_by_count || 0),
    featured: item?.featured === true,
    verifiedLanguages
  };
  voice.qualityScore = voiceSampleQualityScore(voice);
  voice.qualityLabel = voiceSampleQualityLabel(voice);
  return voice;
}

export function buildVoiceSampleSearchUrl({
  query = '',
  gender = '',
  age = '',
  accent = '',
  language = 'en',
  category = '',
  page = 0,
  pageSize = DEFAULT_PAGE_SIZE
} = {}) {
  const url = new URL(SHARED_VOICES_ENDPOINT);
  url.searchParams.set('page_size', String(Math.max(1, Math.min(100, Number(pageSize) || DEFAULT_PAGE_SIZE))));
  url.searchParams.set('page', String(Math.max(0, Number(page) || 0)));
  if (clean(category)) url.searchParams.set('category', clean(category).toLowerCase());
  url.searchParams.set('sort', 'usage_character_count_1y');
  if (clean(query)) url.searchParams.set('search', clean(query));
  if (clean(gender)) url.searchParams.set('gender', clean(gender).toLowerCase());
  if (clean(age)) url.searchParams.set('age', clean(age).toLowerCase());
  if (clean(accent)) url.searchParams.set('accent', clean(accent).toLowerCase());
  if (clean(language)) url.searchParams.set('language', clean(language).toLowerCase());
  return url.toString();
}

export async function searchVoiceSamples(filters = {}, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Voice search is unavailable in this browser.');
  }

  // The provider accepts one category at a time. Blend its quality-curated and
  // professional streams so high-quality voices cannot be buried behind pages
  // of globally popular professional results before local scoring runs.
  const categories = ['high_quality', 'professional'];
  let payloads;
  try {
    payloads = await Promise.all(categories.map(async category => {
      const response = await fetchImpl(buildVoiceSampleSearchUrl({ ...filters, category }), {
        headers: { Accept: 'application/json' },
        referrerPolicy: 'no-referrer',
        signal
      });
      if (!response.ok) {
        const error = new Error(response.status === 429
          ? 'The voice catalog is busy. Wait a moment and try again.'
          : 'The voice catalog is temporarily unavailable.');
        error.status = response.status;
        throw error;
      }
      return await response.json();
    }));
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (error?.status) throw error;
    throw new Error(error instanceof SyntaxError
      ? 'The voice catalog returned an unreadable response.'
      : 'The voice catalog could not be reached. Check your connection and try again.');
  }

  const normalized = payloads.flatMap(payload => Array.isArray(payload?.voices) ? payload.voices : [])
    .map(item => normalizeSharedVoice(item, filters.language))
    .filter(voice => voice.id && voice.previewUrl);
  const bestById = new Map();
  for (const voice of normalized) {
    const current = bestById.get(voice.id);
    if (!current || voice.qualityScore > current.qualityScore) bestById.set(voice.id, voice);
  }
  const voices = [...bestById.values()]
    .sort((a, b) => b.qualityScore - a.qualityScore || b.usageCount - a.usageCount);

  return {
    voices,
    hasMore: payloads.some(payload => payload?.has_more === true),
    totalCount: payloads.reduce((sum, payload) => sum + Math.max(0, Number(payload?.total_count || 0)), 0),
    page: Math.max(0, Number(filters.page) || 0)
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
  if (!voice?.previewUrl || !/^https:\/\//i.test(voice.previewUrl)) {
    throw new Error('This voice does not have a downloadable preview.');
  }

  let response;
  try {
    response = await fetchImpl(voice.previewUrl, {
      referrerPolicy: 'no-referrer',
      signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('The voice preview could not be downloaded.');
  }

  if (!response.ok) throw new Error('The voice preview could not be downloaded.');
  const contentType = response.headers?.get?.('content-type') || 'audio/mpeg';
  const blob = await readBoundedResponseBlob(response, {
    maxBytes: MAX_SAMPLE_BYTES,
    signal,
    contentType,
    tooLargeError: () => new Error('That voice preview is too large to import.'),
    unsafeFallbackError: () => new Error('This browser cannot safely download that voice preview.')
  });
  if (!blob.size) throw new Error('The downloaded voice preview was empty.');

  return new File([blob], safeFileName(voice.name), {
    type: blob.type || contentType,
    lastModified: Date.now()
  });
}

export const VOICE_SAMPLE_CATALOG = Object.freeze({
  provider: 'ElevenLabs Voice Library',
  estimatedVoices: '10,000+',
  pageSize: DEFAULT_PAGE_SIZE
});

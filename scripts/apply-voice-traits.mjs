#!/usr/bin/env node
/**
 * Adds the sourced age, accent and perceived-gender fields to the shipped
 * catalog.
 *
 * Deliberately reads `public/voice-samples/catalog.json` rather than the
 * corpus. Rebuilding from LibriTTS-R means a 37 GB download; relabelling the
 * catalog we already ship costs nothing, so retuning a cut point must never
 * require the former. `build-voice-catalog.mjs` applies the same traits during
 * a full rebuild, via the same module, so the two cannot drift.
 *
 * Usage:
 *   node scripts/apply-voice-traits.mjs [--report] [--check] [--recut]
 *
 * --report prints the resulting distributions. --check verifies the catalog is
 * already up to date and exits non-zero if it is not, without writing. --recut
 * prints the cut points the current catalog implies, which is how AGE_CUTS gets
 * retuned; it does not apply them, because a band must not drift with whichever
 * speakers happen to be in the catalog on a given run.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AGE_CUTS,
  accentLabelFor,
  accentOptionsFrom,
  ageBandFor,
  ageCutsFor,
  perceivedGenderFor,
} from './voice-trait-bands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'public', 'voice-samples', 'catalog.json');
const TRAITS_PATH = path.join(ROOT, 'scripts', 'voice-traits.json');

export async function readTraits(traitsPath = TRAITS_PATH) {
  const payload = JSON.parse(await fs.readFile(traitsPath, 'utf8'));
  return payload?.speakers && typeof payload.speakers === 'object' ? payload : { speakers: {} };
}

/** LibriTTS-R speaker id behind a catalog entry, e.g. `libritts-r-4214` -> `4214`. */
function readerIdOf(entry) {
  return String(entry?.id || '')
    .split('-')
    .at(-1);
}

/**
 * Returns a new voices array with the trait fields applied. Exported so the
 * corpus build and the relabel path share one implementation.
 */
export function applyTraits(voices, traits, cuts = AGE_CUTS) {
  const speakers = traits?.speakers || {};

  return voices.map((entry) => {
    const record = speakers[readerIdOf(entry)] || {};
    const ageBand = ageBandFor(record.ageScore, entry.gender, cuts);
    const accent = accentLabelFor(record.accent);
    const perceivedGender = perceivedGenderFor(record.perceivedGender, entry.gender);
    // Written in a fixed position so a re-run is a no-op diff rather than a
    // reordering of every entry.
    const next = { ...entry, ageBand, accent };
    if (perceivedGender) next.perceivedGender = perceivedGender;
    else delete next.perceivedGender;
    return next;
  });
}

/** The facet lists the filter UI offers, describing what the data actually holds. */
export function facetsFor(voices) {
  return { accents: accentOptionsFrom(voices.map((voice) => voice.accent)) };
}

function report(voices) {
  const count = (key) => {
    const tally = new Map();
    for (const voice of voices) tally.set(voice[key], (tally.get(voice[key]) || 0) + 1);
    return Object.fromEntries([...tally].sort((a, b) => b[1] - a[1]));
  };

  console.log('\nage band:', count('ageBand'));
  console.log('accent:', count('accent'));

  const byGender = new Map();
  for (const voice of voices) {
    if (!byGender.has(voice.gender)) byGender.set(voice.gender, new Map());
    const bands = byGender.get(voice.gender);
    bands.set(voice.ageBand, (bands.get(voice.ageBand) || 0) + 1);
  }
  for (const [gender, bands] of [...byGender].sort()) {
    // Median measured pitch per band is the cross-check that the bands track
    // something real: it is our own measurement, computed independently of the
    // annotators, and it should fall monotonically young -> adult -> senior.
    const summary = [...bands]
      .sort()
      .map(([band, n]) => {
        const pitches = voices
          .filter((voice) => voice.gender === gender && voice.ageBand === band)
          .map((voice) => voice.pitchHz || 0)
          .sort((a, b) => a - b);
        return `${band} ${n} (median ${pitches[Math.floor(pitches.length / 2)] || 0} Hz)`;
      })
      .join(', ');
    console.log(`  ${gender}: ${summary}`);
  }

  const perceived = voices.filter((voice) => voice.perceivedGender).length;
  console.log(`\nreaders whose perceived gender differs from the corpus: ${perceived}`);
}

async function main() {
  const args = process.argv.slice(2);
  const traits = await readTraits();
  const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8'));
  const voices = applyTraits(catalog.voices || [], traits);

  if (args.includes('--recut')) {
    const scored = (catalog.voices || []).map((entry) => ({
      gender: entry.gender,
      ageScore: traits.speakers?.[readerIdOf(entry)]?.ageScore ?? null,
    }));
    console.log('cut points this catalog implies:', JSON.stringify(ageCutsFor(scored), null, 2));
    console.log('in use (AGE_CUTS):', JSON.stringify(AGE_CUTS, null, 2));
    console.log('\nTo adopt these, edit AGE_CUTS in scripts/voice-trait-bands.mjs, then re-run without --recut.');
    return;
  }

  // Facets ahead of the voices array so the file still opens with its header
  // rather than burying it after 250 KB of entries.
  const { voices: _previous, ...header } = catalog;
  const serialized = `${JSON.stringify({ ...header, ...facetsFor(voices), voices })}\n`;
  const unchanged = serialized === (await fs.readFile(CATALOG_PATH, 'utf8'));

  if (args.includes('--report')) report(voices);

  if (args.includes('--check')) {
    if (unchanged) {
      console.log('catalog.json is up to date with voice-traits.json');
      return;
    }
    console.error('catalog.json is stale — run: node scripts/apply-voice-traits.mjs');
    process.exitCode = 1;
    return;
  }

  await fs.writeFile(CATALOG_PATH, serialized);
  const missing = voices.filter((voice) => voice.ageBand === 'unspecified').length;
  console.log(
    `${unchanged ? 'unchanged' : 'updated'} ${path.relative(ROOT, CATALOG_PATH)} — ` +
      `${voices.length} voices, ${missing} without an age band ` +
      `(${(serialized.length / 1000).toFixed(0)} KB)`,
  );
}

// pathToFileURL, not a `file://` template: import.meta.url percent-encodes the
// path while argv does not, so the naive comparison is false for any checkout
// under a directory with a space in it, and the script would exit 0 having
// silently done nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

/**
 * Turns the pooled annotation scores in `voice-traits.json` into the bands a
 * voice card shows.
 *
 * Kept separate from both the fetcher and the corpus build for the same reason
 * `--relabel` exists: fetching is expensive and the cut points are not. Every
 * threshold here can be retuned and reapplied without touching the network.
 */

// Band names live beside REGISTER_LABELS in src/audio/voice-sample-catalog.js,
// the same way registerFor's bands do.
export const UNSPECIFIED_ACCENT = 'Unspecified';

/**
 * The source spells its own unknown bucket "Unindentified". Normalise it rather
 * than shipping the typo, and fold anything else falsy into the same bucket so
 * an uncovered reader and an explicitly-unknown one read identically.
 */
export function accentLabelFor(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || /^unin?dentified$/i.test(value)) return UNSPECIFIED_ACCENT;
  // "New zealand" and "Latin american" arrive sentence-cased; leave the casing
  // the source chose alone beyond trimming, so the filter list matches the data.
  return value;
}

/**
 * Age cut points, per corpus gender.
 *
 * Per gender because the annotators used the age vocabulary on a
 * gender-relative scale: `mature` was applied to 84.7% of the male speakers in
 * this catalog but only 3.4% of the female ones. One global threshold therefore
 * sorts 325 men and 9 women into `senior`, which describes the annotation
 * convention rather than the voices. Ranking each speaker against their own
 * gender's distribution removes that skew and leaves a split that is even
 * across both: 227 young, 676 adult, 243 senior.
 *
 * Frozen as literals for the same reason `paceFor` in build-voice-catalog.mjs
 * freezes 165/200. They were read off the p25/p75 of each gender's score
 * distribution over the full shipped catalog — rerun `ageCutsFor` to reproduce
 * them — but recomputing them per run would make a reader's band depend on
 * which other readers happen to be in the catalog, so `--subsets dev-clean`
 * would quietly assign different ages than a full build.
 */
export const AGE_CUTS = {
  Female: { young: -0.1667, senior: 0.3333 },
  Male: { young: 0.4167, senior: 1.5833 },
};

export const AGE_QUANTILES = { young: 0.25, senior: 0.75 };

function quantile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/**
 * Recomputes the cut points from a scored speaker set. This is the tool that
 * produced `AGE_CUTS`, not something the build calls: banding reads the frozen
 * constants so the bands stay stable, and this is how you retune them when the
 * corpus or the annotation sets change. Speakers with no score do not vote.
 */
export function ageCutsFor(scored) {
  const byGender = new Map();
  for (const { gender, ageScore } of scored) {
    if (typeof ageScore !== 'number' || Number.isNaN(ageScore)) continue;
    if (!byGender.has(gender)) byGender.set(gender, []);
    byGender.get(gender).push(ageScore);
  }

  const cuts = {};
  for (const [gender, scores] of byGender) {
    scores.sort((a, b) => a - b);
    cuts[gender] = {
      young: quantile(scores, AGE_QUANTILES.young),
      senior: quantile(scores, AGE_QUANTILES.senior),
    };
  }
  return cuts;
}

/**
 * A speaker with no annotation is `unspecified`, never quietly folded into
 * `adult` — an uncovered reader is a gap in the data, not a middle-aged one.
 * So is a speaker whose gender has no cut points, because there is nothing to
 * rank their score against.
 */
export function ageBandFor(ageScore, gender, cuts = AGE_CUTS) {
  if (typeof ageScore !== 'number' || Number.isNaN(ageScore)) return 'unspecified';
  const cut = Object.hasOwn(cuts || {}, gender) ? cuts[gender] : null;
  if (!cut) return 'unspecified';
  if (ageScore < cut.young) return 'young';
  if (ageScore > cut.senior) return 'senior';
  return 'adult';
}

/**
 * The perception word a given corpus gender already implies. `Neutral` — what
 * `entryFor` emits for a speaker whose sex the table omits — is agreed with by
 * `gender-neutral`, so it needs an entry too; without one, the agreeing answer
 * would be reported as a contradiction.
 */
const IMPLIED_PERCEPTION = { Female: 'feminine', Male: 'masculine', Neutral: 'gender-neutral' };

/**
 * The perception words are only worth surfacing where they contradict the
 * corpus, which is the case a director actually needs warning about: a reader
 * the speaker table records as one sex whose recording reads as the other.
 */
export function perceivedGenderFor(word, gender) {
  const value = typeof word === 'string' ? word.trim().toLowerCase() : '';
  if (!value) return '';
  return value === IMPLIED_PERCEPTION[gender] ? '' : value;
}

/**
 * Accents in the order a filter should offer them: commonest first so the
 * useful choices are reachable without scrolling, `Unspecified` always last
 * because it is a gap rather than a trait.
 */
export function accentOptionsFrom(accents) {
  const counts = new Map();
  for (const raw of accents) {
    const label = accentLabelFor(raw);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => {
      if (a[0] === UNSPECIFIED_ACCENT) return 1;
      if (b[0] === UNSPECIFIED_ACCENT) return -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    })
    .map(([label]) => label);
}

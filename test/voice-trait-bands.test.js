import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTraits, facetsFor } from '../scripts/apply-voice-traits.mjs';
import {
  AGE_CUTS,
  accentLabelFor,
  accentOptionsFrom,
  ageBandFor,
  ageCutsFor,
  perceivedGenderFor,
  UNSPECIFIED_ACCENT,
} from '../scripts/voice-trait-bands.mjs';

function entry(id, gender, extra = {}) {
  return { id: `libritts-r-${id}`, name: `Reader ${id}`, gender, pitchHz: 150, ...extra };
}

/** Ten scores per gender so the p25/p75 cuts land on predictable elements. */
function spread(gender, base) {
  return Array.from({ length: 10 }, (_, index) => ({ gender, ageScore: base + index }));
}

test('age cuts are taken per gender, not across the whole catalog', () => {
  const cuts = ageCutsFor([...spread('Male', 10), ...spread('Female', 0)]);

  // The annotators used the age words on a gender-relative scale — `mature` was
  // applied to 84.7% of the male readers in this catalog but only 3.4% of the
  // female ones. Ranking each reader against their own gender is what stops a
  // single global threshold from filing almost every man as senior.
  assert.equal(cuts.Male.young, 12);
  assert.equal(cuts.Male.senior, 17);
  assert.equal(cuts.Female.young, 2);
  assert.equal(cuts.Female.senior, 7);

  assert.equal(ageBandFor(11, 'Male', cuts), 'young');
  assert.equal(ageBandFor(11, 'Female', cuts), 'senior', 'the same score reads differently per gender');
});

test('an unscored or unknown-gender reader is unspecified rather than adult', () => {
  const cuts = ageCutsFor(spread('Male', 0));

  assert.equal(ageBandFor(null, 'Male', cuts), 'unspecified');
  assert.equal(ageBandFor(undefined, 'Male', cuts), 'unspecified');
  assert.equal(ageBandFor(Number.NaN, 'Male', cuts), 'unspecified');
  // No cut exists for a gender nobody scored, so there is nothing to rank
  // against; guessing the middle band would state something unrecorded.
  assert.equal(ageBandFor(3, 'Neutral', cuts), 'unspecified');
  // A gender name that only resolves through Object.prototype is not a gender.
  assert.equal(ageBandFor(3, 'constructor', cuts), 'unspecified');
});

test('the shipped cut points are frozen, not recomputed per run', () => {
  // A reader's band must depend on their own score, not on which other readers
  // happen to be in the catalog. Recomputing quartiles per run meant
  // `--subsets dev-clean` reassigned 6 of its 37 readers.
  const dogsbody = { gender: 'Male', ageScore: 2.0 };
  assert.equal(ageBandFor(dogsbody.ageScore, dogsbody.gender), 'senior');
  assert.equal(
    ageBandFor(dogsbody.ageScore, dogsbody.gender, ageCutsFor([dogsbody, { gender: 'Male', ageScore: 3.0 }])),
    'adult',
    'this is what a per-run recompute would have produced, and why it is not the default',
  );
  assert.deepEqual(Object.keys(AGE_CUTS).sort(), ['Female', 'Male']);
});

test('accent labels normalise the source spelling and fold every gap into one bucket', () => {
  assert.equal(accentLabelFor('American'), 'American');
  assert.equal(accentLabelFor('  Irish  '), 'Irish');
  // The upstream column spells its own unknown bucket "Unindentified".
  assert.equal(accentLabelFor('Unindentified'), UNSPECIFIED_ACCENT);
  assert.equal(accentLabelFor('Unidentified'), UNSPECIFIED_ACCENT);
  assert.equal(accentLabelFor(''), UNSPECIFIED_ACCENT);
  assert.equal(accentLabelFor(undefined), UNSPECIFIED_ACCENT);
});

test('accent options are ordered by frequency with the gap last', () => {
  const options = accentOptionsFrom(['Irish', 'American', 'American', 'Unindentified', 'American', 'Irish', '']);
  assert.deepEqual(options, ['American', 'Irish', UNSPECIFIED_ACCENT]);
});

test('perceived gender is recorded only where it contradicts the corpus', () => {
  assert.equal(perceivedGenderFor('feminine', 'Female'), '');
  assert.equal(perceivedGenderFor('masculine', 'Male'), '');
  assert.equal(perceivedGenderFor('masculine', 'Female'), 'masculine');
  assert.equal(perceivedGenderFor('gender-neutral', 'Male'), 'gender-neutral');
  assert.equal(perceivedGenderFor('', 'Male'), '');
  // `entryFor` emits Neutral for a speaker the corpus table gives no sex, and
  // gender-neutral is the perception that agrees with it — flagging that as a
  // contradiction would put a warning on a card that has nothing to warn about.
  assert.equal(perceivedGenderFor('gender-neutral', 'Neutral'), '');
  assert.equal(perceivedGenderFor('masculine', 'Neutral'), 'masculine');
});

test('applying traits bands the catalog and leaves uncovered readers alone', () => {
  const voices = [...spread('Male', 0).map((_row, index) => entry(`m${index}`, 'Male')), entry('uncovered', 'Male')];
  const traits = {
    speakers: Object.fromEntries(
      spread('Male', 0).map((row, index) => [
        `m${index}`,
        { ageScore: row.ageScore, accent: index === 0 ? 'Unindentified' : 'Irish', perceivedGender: 'feminine' },
      ]),
    ),
  };

  const applied = applyTraits(voices, traits);
  const uncovered = applied.at(-1);

  assert.equal(uncovered.ageBand, 'unspecified');
  assert.equal(uncovered.accent, UNSPECIFIED_ACCENT);
  assert.equal(applied[0].ageBand, 'young');
  assert.equal(applied[0].accent, UNSPECIFIED_ACCENT, 'the source typo is normalised on the way in');
  assert.equal(applied.at(-2).ageBand, 'senior');
  assert.equal(applied[0].perceivedGender, 'feminine', 'a male reader heard as feminine is worth flagging');
  assert.equal('perceivedGender' in uncovered, false);

  // The uncovered reader has no score, so it must not shift where the cuts fall.
  assert.deepEqual(
    applyTraits(voices.slice(0, -1), traits).map((voice) => voice.ageBand),
    applied.slice(0, -1).map((voice) => voice.ageBand),
  );

  assert.deepEqual(facetsFor(applied).accents, ['Irish', UNSPECIFIED_ACCENT]);
});

test('re-applying traits to an already-banded catalog changes nothing', () => {
  const voices = spread('Female', 0).map((_row, index) => entry(`f${index}`, 'Female'));
  const traits = {
    speakers: Object.fromEntries(
      spread('Female', 0).map((row, index) => [`f${index}`, { ageScore: row.ageScore, accent: 'Canadian' }]),
    ),
  };

  const once = applyTraits(voices, traits);
  assert.deepEqual(applyTraits(once, traits), once);
});

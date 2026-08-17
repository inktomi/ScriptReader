import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accentHintFrom,
  ageBandForYears,
  castRoles,
  catalogFiltersForRole,
  pickVoiceForRole,
  scoreVoiceForRole,
  voiceTraits,
} from '../src/audio/voice-casting.js';
import { characterCastingTraits } from '../src/audio/voice-catalog.js';

function catalogVoice(id, gender, ageBand, accent, extra = {}) {
  return {
    id,
    name: id,
    gender,
    ageBand,
    ageLabel: ageBand ? ageBand[0].toUpperCase() + ageBand.slice(1) : 'Unspecified',
    accent: accent || 'Unspecified',
    register: 'mid',
    snrDb: 30,
    ...extra,
  };
}

/** An introduction as character-introductions.js attaches it. */
function intro(text, age = null) {
  return { text, age, sourceText: text };
}

test('character age in years maps onto the catalog bands', () => {
  assert.equal(ageBandForYears(17), 'young');
  assert.equal(ageBandForYears(29), 'young');
  assert.equal(ageBandForYears(30), 'adult');
  assert.equal(ageBandForYears(54), 'adult');
  assert.equal(ageBandForYears(55), 'senior');
  // A script that never gave an age must not be answered with a guess.
  assert.equal(ageBandForYears(null), null);
  assert.equal(ageBandForYears(Number.NaN), null);
});

test('an accent the writer named is recognised, and silence names none', () => {
  assert.equal(accentHintFrom(['A', 'SCOTTISH', 'DOCKWORKER']), 'Scottish');
  assert.equal(accentHintFrom(['THE', 'BUTLER']), 'English');
  assert.equal(accentHintFrom(['A', 'TIRED', 'DETECTIVE']), '');
});

test('the store placeholders for a missing trait read as absent, not as a value', () => {
  // chatterbox-voice-store falls back to these for a private upload. Matching
  // on them would treat "we do not know" as a trait two voices share.
  const uploaded = voiceTraits({ sex: 'Neutral', ageGroup: 'Reference performance', accent: 'Cloned' });
  assert.equal(uploaded.ageBand, '');
  assert.equal(uploaded.accent, '');

  const imported = voiceTraits({ sex: 'Female', ageGroup: 'Senior', accent: 'Irish', register: 'low' });
  assert.deepEqual(imported, { sex: 'Female', ageBand: 'senior', accent: 'Irish', register: 'low' });
});

test('a gendered noun outranks a pronoun that belongs to somebody else', () => {
  // The construction is common in introductions and the failure is the worst
  // one available: "her grandson" read as female and cast a man as a woman.
  assert.equal(characterCastingTraits('DECLAN', { introduction: intro('DECLAN, 20s, her grandson.') }).isFemale, false);
  assert.equal(characterCastingTraits('MAEVE', { introduction: intro('MAEVE, 40s, his wife.') }).isFemale, true);

  // A pronoun is still the signal when no noun names the subject — the case
  // the pronoun check was added for.
  assert.equal(
    characterCastingTraits('CHEN', { introduction: intro('COMMANDER CHEN, 30s, grease on her forehead.') }).isFemale,
    true,
  );
  // And a name still decides when the introduction says nothing either way.
  assert.equal(characterCastingTraits('SARAH', {}).isFemale, true);
  assert.equal(characterCastingTraits('GUARD', {}).isFemale, false);
});

test('female role nouns are recognised rather than defaulting to male', () => {
  for (const noun of ['matriarch', 'duchess', 'actress', 'heiress', 'bride']) {
    assert.equal(
      characterCastingTraits('ROLE', { introduction: intro(`ROLE, 50s, the ${noun}.`) }).isFemale,
      true,
      `${noun} should read female`,
    );
  }
});

test('sex is a veto, not a weight', () => {
  const traits = characterCastingTraits('MARCUS', { introduction: intro('MARCUS, 40s, a tired detective.', '40s') });
  assert.equal(scoreVoiceForRole(catalogVoice('f', 'Female', 'adult', ''), traits), -1);
  assert.ok(scoreVoiceForRole(catalogVoice('m', 'Male', 'adult', ''), traits) > 0);
});

test('the written age and accent outrank a voice that only matches sex', () => {
  const traits = characterCastingTraits('OONAGH', {
    introduction: intro('OONAGH, 70s, an Irish matriarch.', '70s'),
  });
  const exact = catalogVoice('exact', 'Female', 'senior', 'Irish');
  const rightSexOnly = catalogVoice('plain', 'Female', '', '');
  const wrongAge = catalogVoice('wrongAge', 'Female', 'young', 'Irish');

  assert.ok(scoreVoiceForRole(exact, traits) > scoreVoiceForRole(rightSexOnly, traits));
  // An unannotated voice scores zero for the trait; a contradicting one loses
  // ground. Both are beaten by the match, and the gap is in the right order.
  assert.ok(scoreVoiceForRole(rightSexOnly, traits) > scoreVoiceForRole(wrongAge, traits));
});

test('an ensemble is spread across registers so characters stay tellable apart', () => {
  const traits = characterCastingTraits('GUARD', {});
  const deep = catalogVoice('deep', 'Male', '', '', { register: 'deep' });
  const mid = catalogVoice('mid', 'Male', '', '', { register: 'mid' });

  // With nothing cast, the cleaner recording wins on the SNR tiebreak.
  assert.equal(pickVoiceForRole([deep, mid], traits, { used: new Set() }).id, 'deep');

  // Once a deep voice is spoken for, a different register is worth more than a
  // marginally cleaner recording in the one already used.
  const cleanerDeep = catalogVoice('deep2', 'Male', '', '', { register: 'deep', snrDb: 45 });
  const taken = new Set(['deep']);
  const pool = [deep, cleanerDeep, mid];
  assert.equal(pickVoiceForRole(pool, traits, { used: taken }).id, 'mid');
});

test('casting a script matches each role and never doubles up a voice', () => {
  const characters = [
    { name: 'OONAGH', lineCount: 20, introduction: intro('OONAGH, 70s, an Irish matriarch.', '70s') },
    { name: 'DECLAN', lineCount: 12, introduction: intro('DECLAN, 20s, her grandson.', '20s') },
    { name: 'NARRATOR', lineCount: 8 },
  ];
  const pool = [
    catalogVoice('old-irish-f', 'Female', 'senior', 'Irish'),
    catalogVoice('young-m', 'Male', 'young', 'American', { register: 'bright' }),
    catalogVoice('old-m', 'Male', 'senior', 'American', { register: 'deep' }),
  ];

  const cast = castRoles(characters, pool);
  assert.equal(cast.get('OONAGH').id, 'old-irish-f');
  assert.equal(cast.get('DECLAN').id, 'young-m');
  // The narrator is cast separately, from the narrator pool.
  assert.equal(cast.has('NARRATOR'), false);
  assert.equal(new Set([...cast.values()].map((v) => v.id)).size, cast.size);
});

test('a role the pool cannot serve is left uncast rather than mis-cast', () => {
  const characters = [{ name: 'MARLA', lineCount: 5, introduction: intro('MARLA, 30s, she waits.', '30s') }];
  const cast = castRoles(characters, [catalogVoice('m', 'Male', 'adult', '')]);
  // Handing her a man's voice would be a wrong take, not a near miss.
  assert.equal(cast.size, 0);
});

test('reserved voices stay reserved', () => {
  const characters = [{ name: 'SAM', lineCount: 3 }];
  const pool = [catalogVoice('taken', 'Male', '', ''), catalogVoice('free', 'Male', '', '')];
  const cast = castRoles(characters, pool, { reserved: ['taken'] });
  assert.equal(cast.get('SAM').id, 'free');
});

test('catalog filters for a role come from the script, and stay blank where it was silent', () => {
  assert.deepEqual(
    catalogFiltersForRole('OONAGH', { introduction: intro('OONAGH, 70s, an Irish matriarch.', '70s') }),
    { query: '', gender: 'female', age: 'senior', accent: 'Irish', register: '', pace: '' },
  );

  // No age written and no accent named: filter on what is known, and do not
  // narrow the catalog on a guess the script never made.
  const sparse = catalogFiltersForRole('GUARD', {});
  assert.equal(sparse.age, '');
  assert.equal(sparse.accent, '');
  assert.equal(sparse.gender, 'male');
});

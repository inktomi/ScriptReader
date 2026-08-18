import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachCharacterGender,
  genderFromTally,
  inferCharacterGender,
  tallyGenderPronouns,
} from '../src/screenplay/character-gender.js';

const action = (text) => ({ type: 'ACTION', text });
const line = (character, text) => ({ type: 'DIALOGUE', character, text });
const scene = (text) => ({ type: 'SCENE_HEADING', text });

test('a character the script only ever pronouns is still resolved', () => {
  // Nothing about "LEE" says female, and the script never writes "woman". The
  // action lines say it constantly, which is where casting was not looking.
  const parsed = {
    characters: [{ name: 'LEE' }],
    elements: [
      action('LEE VALMONT (22) — sits at her desk, hunched forward.'),
      action('Her laptop glows before her.'),
      action('She reads with a flat, unreadable expression.'),
      action('She flips a switch. A ring light floods the space.'),
    ],
  };
  assert.equal(inferCharacterGender(parsed).get('LEE'), 'Female');
});

test('a pronoun is credited to the character most recently named', () => {
  const counts = tallyGenderPronouns({
    characters: [{ name: 'LEE' }, { name: 'JAY' }],
    elements: [action('Lee closes the laptop. She stands.'), action('Jay waits. He checks his watch.')],
  });
  assert.deepEqual(counts.get('LEE'), { female: 1, male: 0 });
  assert.deepEqual(counts.get('JAY'), { female: 0, male: 2 });
});

test('a speaker is the antecedent for the action that follows their line', () => {
  const counts = tallyGenderPronouns({
    characters: [{ name: 'BRENDA' }],
    elements: [line('BRENDA', 'And you did say...'), action('She looks down on him, exhausted.')],
  });
  assert.equal(counts.get('BRENDA').female, 1);
});

test('a scene heading ends the antecedent, so pronouns do not cross the cut', () => {
  const counts = tallyGenderPronouns({
    characters: [{ name: 'LEE' }],
    elements: [action('Lee waits.'), scene('INT. SUV - NIGHT'), action('He lights a cigarette.')],
  });
  assert.equal(counts.get('LEE'), undefined, 'the pronoun after the cut belongs to nobody yet');
});

test('a possessive that names its owner beats the recency guess', () => {
  // `LEE'S` is Lee being named, not a stray token.
  const counts = tallyGenderPronouns({
    characters: [{ name: 'LEE' }, { name: 'JAY' }],
    elements: [action('Jay stands in LEE’S kitchen. She ignores him.')],
  });
  assert.equal(counts.get('LEE').female, 1);
});

test('a verdict needs a real majority over a real sample', () => {
  // Recency attribution is not perfect — "Lee looks at Jay. She turns away."
  // credits Jay — so a thin or split count reports nothing and lets the older
  // name-and-introduction reasoning decide instead of being overridden by noise.
  assert.equal(genderFromTally({ female: 3, male: 0 }), null, 'too small a sample');
  assert.equal(genderFromTally({ female: 30, male: 23 }), null, 'no clear majority');
  assert.equal(genderFromTally({ female: 24, male: 3 }), 'Female');
  assert.equal(genderFromTally({ female: 6, male: 48 }), 'Male');
  assert.equal(genderFromTally(undefined), null);
});

test('attaching always defines the field, null included', () => {
  const parsed = {
    characters: [{ name: 'LEE' }, { name: 'GHOST' }],
    elements: [action('Lee waits. She waits. She waits. She waits. She waits.')],
  };
  attachCharacterGender(parsed);
  assert.equal(parsed.characters[0].gender, 'Female');
  assert.equal(parsed.characters[1].gender, null, 'a character the script never leans about');
  // Idempotent.
  attachCharacterGender(parsed);
  assert.equal(parsed.characters[0].gender, 'Female');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFountainScript } from '../src/screenplay/fountain-parser.js';
import { chunkSpeech } from '../src/audio/performance-director.js';
import {
  isPdfDialogueContinuation,
  shouldSplitPdfDialogueAtParenthetical
} from '../src/screenplay/pdf-layout.js';

test('titleless Fountain input keeps its opening scene and action', () => {
  const parsed = parseFountainScript([
    'INT. ROOM - DAY',
    'A lamp flickers.',
    '',
    'BOB',
    'Hello.'
  ].join('\n'));

  assert.equal(parsed.elements[0].type, 'SCENE_HEADING');
  assert.equal(parsed.elements[0].text, 'INT. ROOM - DAY');
  assert.equal(parsed.elements[1].type, 'ACTION');
  assert.equal(parsed.elements[1].text, 'A lamp flickers.');
});

test('uppercase action ending in punctuation is not treated as a character cue', () => {
  const parsed = parseFountainScript('THE DOOR EXPLODES.\nSmoke fills the room.');
  assert.deepEqual(parsed.elements.map(element => element.type), ['ACTION', 'ACTION']);
  assert.equal(parsed.characters.length, 0);
});

test('character initials ending in a period remain valid cues', () => {
  const parsed = parseFountainScript('J.J.\nHello there.');
  assert.equal(parsed.elements[0].type, 'DIALOGUE');
  assert.equal(parsed.elements[0].character, 'J.J.');
});

test('spaced and suffixed character initials remain valid cues', () => {
  for (const cue of ['J. J.', 'J.J. JR.']) {
    const parsed = parseFountainScript(`${cue}\nHello there.`);
    assert.equal(parsed.elements[0].type, 'DIALOGUE');
    assert.equal(parsed.elements[0].character, cue);
  }
});

test('abbreviated character names remain valid cues', () => {
  for (const cue of ['DR.', 'JOHN JR.']) {
    const parsed = parseFountainScript(`${cue}\nHello there.`);
    assert.equal(parsed.elements[0].type, 'DIALOGUE');
    assert.equal(parsed.elements[0].character, cue);
  }
});

test('uppercase action ending in a street abbreviation is not a cue', () => {
  const parsed = parseFountainScript('THEY ARRIVE AT MAIN ST.\nThen wait.');
  assert.deepEqual(parsed.elements.map(element => element.type), ['ACTION', 'ACTION']);
  assert.equal(parsed.characters.length, 0);
});

test('speech chunks never exceed the engine limit, even without punctuation or commas', () => {
  const chunks = chunkSpeech('word '.repeat(120), 190);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 190));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), 'word '.repeat(120).trim());
});

test('PDF dialogue ends when extraction returns to the action margin', () => {
  assert.equal(isPdfDialogueContinuation(true, 'BOB', 0.35), true);
  assert.equal(isPdfDialogueContinuation(true, 'BOB', 0.11), false);
});

test('an inline PDF parenthetical splits already accumulated dialogue', () => {
  assert.equal(shouldSplitPdfDialogueAtParenthetical(['First phrase.']), true);
  assert.equal(shouldSplitPdfDialogueAtParenthetical([]), false);
});

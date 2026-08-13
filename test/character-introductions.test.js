import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFountainScript } from '../src/screenplay/fountain-parser.js';
import { findCharacterIntroductions } from '../src/screenplay/character-introductions.js';
import { getSuggestedVoiceForCharacter, getVoiceById } from '../src/audio/voice-catalog.js';
import { SAMPLE_SCRIPTS } from '../src/screenplay/sample-scripts.js';
import { createCastPanel } from '../src/ui/cast-panel.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';
import { installDom, removeDom } from './dom-helpers.js';

function introOf(parsed, name) {
  return parsed.characters.find(character => character.name === name)?.introduction ?? null;
}

function sample(id) {
  return parseFountainScript(SAMPLE_SCRIPTS.find(script => script.id === id).fountainText);
}

test('bundled samples yield the introduction the writer actually wrote', () => {
  const heist = sample('neon-heist');
  assert.equal(introOf(heist, 'VALENTINE').text, '30s, rugged, cybernetic trenchcoat');
  assert.equal(introOf(heist, 'VALENTINE').age, '30s');
  assert.equal(introOf(heist, 'KIRA').text, '20s, agile, neural visor glowing amber');

  // The name is in the middle of the line: "AT THE VAULT ENTRANCE: COMMANDER
  // BRIGGS (50s, ...)". Anchoring on the start of the line would miss it.
  assert.equal(introOf(heist, 'COMMANDER BRIGGS').text, '50s, towering, heavy combat armor');
  assert.equal(introOf(heist, 'COMMANDER BRIGGS').form, 'parenthetical');

  // Periods inside a name must not split it or end a sentence early.
  const manor = sample('midnight-manor');
  assert.equal(introOf(manor, 'MRS. HIGGINS').text, '50s, nervous housekeeper, trembling hands');
  assert.equal(introOf(sample('station-zero'), 'DR. ARIS').text, '40s, disheveled, pacing frantically');
});

test('a character the script never described gets null, not a guess', () => {
  assert.equal(introOf(sample('neon-heist'), 'CYPHER'), null);
  assert.equal(introOf(sample('station-zero'), 'AI MOTHER'), null);

  // Every cast member here is named in the action, but only ever bare.
  const hearing = sample('crossfire-hearing');
  assert.deepEqual(hearing.characters.map(character => character.introduction), [null, null, null]);
});

test('extraction never writes to elements', () => {
  // `hashScript` folds every element's type, character, text and parenthetical
  // into the per-script storage key, so reclassifying one line orphans every
  // saved cast. Frozen elements turn any write into a TypeError under ESM's
  // implicit strict mode, which is stronger than comparing before-and-after.
  const parsed = sample('neon-heist');
  parsed.elements.forEach(Object.freeze);
  Object.freeze(parsed.elements);

  const found = findCharacterIntroductions(parsed);
  assert.equal(found.get('VALENTINE').text, '30s, rugged, cybernetic trenchcoat');
});

test('no phantom characters and no reclassified lines', () => {
  const parsed = sample('neon-heist');
  assert.deepEqual(
    parsed.characters.map(character => character.name),
    ['VALENTINE', 'KIRA', 'COMMANDER BRIGGS', 'CYPHER']
  );
  // All-caps nouns in the action stay action and stay out of the cast.
  assert.ok(parsed.elements.some(el => el.type === 'ACTION' && el.text.includes('THE NEURO-CORE')));
  assert.ok(parsed.elements.some(el => el.type === 'ACTION' && el.text.includes('RED EMERGENCY LIGHTS FLASH')));
});

test('a name only matches as a whole token', () => {
  const parsed = parseFountainScript([
    'INT. WARD - NIGHT',
    '',
    'KIRAN (40s, a stranger in a borrowed coat) waits by the door.',
    '',
    'KIRA',
    'Who let him in?'
  ].join('\n'));

  assert.equal(introOf(parsed, 'KIRA'), null);
});

test('a short name is not found inside a longer capitalised word', () => {
  const parsed = parseFountainScript([
    'INT. COURTHOUSE - DAY',
    '',
    'THE HALL IS DARK. SIGNAL LIGHTS FLICKER. AL (60s, the janitor, keys on his hip) sweeps.',
    '',
    'AL',
    'Nobody comes down here.'
  ].join('\n'));

  assert.equal(introOf(parsed, 'AL').text, '60s, the janitor, keys on his hip');
  assert.equal(introOf(parsed, 'AL').age, '60s');
});

test('a bare mention yields nothing and the search continues past it', () => {
  const parsed = parseFountainScript([
    'INT. HEARING ROOM - DAY',
    '',
    'The doors open. HOLT takes the chair without looking up.',
    '',
    'HOLT',
    'Order.',
    '',
    'INT. HEARING ROOM - LATER',
    '',
    'CHAIRMAN HOLT (60s, unflappable, half-moon glasses) gavels twice.',
    '',
    'HOLT',
    'We resume.'
  ].join('\n'));

  assert.equal(introOf(parsed, 'HOLT').text, '60s, unflappable, half-moon glasses');
});

test('a surname alone resolves to the character cued with a title', () => {
  const parsed = parseFountainScript([
    'INT. CHAMBER - DAY',
    '',
    'VANCE (50s, silk tie, unhurried) leans into the microphone.',
    '',
    'COUNSEL VANCE',
    'Let the record show.'
  ].join('\n'));

  assert.equal(introOf(parsed, 'COUNSEL VANCE').text, '50s, silk tie, unhurried');
});

test('an ambiguous surname is claimed by nobody', () => {
  const parsed = parseFountainScript([
    'INT. PORCH - DUSK',
    '',
    'SAM (30s, sunburnt, holding a rake) looks up.',
    '',
    'YOUNG SAM',
    'It is getting late.',
    '',
    'OLD SAM',
    'It always is.'
  ].join('\n'));

  assert.equal(introOf(parsed, 'YOUNG SAM'), null);
  assert.equal(introOf(parsed, 'OLD SAM'), null);
});

test('a cue name shorter than the action form still finds its description', () => {
  const parsed = parseFountainScript([
    'INT. LOBBY - MORNING',
    '',
    'CAROL WINTERS (30s, unflappable, coffee in one hand) badges in.',
    '',
    'CAROL',
    'Morning.'
  ].join('\n'));

  assert.equal(introOf(parsed, 'CAROL').text, '30s, unflappable, coffee in one hand');
});

test('an age-led appositive is extracted and a bare clause is not', () => {
  const described = parseFountainScript([
    'EXT. ROADSIDE - NIGHT',
    '',
    'MAYA, 32, a paramedic with steady hands, kneels beside him.',
    '',
    'MAYA',
    'Stay with me.'
  ].join('\n'));
  const intro = introOf(described, 'MAYA');
  assert.equal(intro.text, '32, a paramedic with steady hands');
  assert.equal(intro.age, '32');
  assert.equal(intro.form, 'appositive');

  const undescribed = parseFountainScript([
    'EXT. ROADSIDE - NIGHT',
    '',
    'MAYA, who had been waiting all night, finally stands.',
    '',
    'MAYA',
    'Stay with me.'
  ].join('\n'));
  assert.equal(introOf(undescribed, 'MAYA'), null);
});

test('a cue extension in the action is not a description', () => {
  const parsed = parseFountainScript([
    'INT. VAULT - NIGHT',
    '',
    'KIRA (V.O.) sighs offscreen.',
    '',
    'KIRA',
    'I am still here.'
  ].join('\n'));

  assert.equal(introOf(parsed, 'KIRA'), null);
});

test('a parenthetical belonging to the next sentence is not attached backwards', () => {
  const parsed = parseFightScript();
  assert.equal(introOf(parsed, 'BRIGGS'), null);

  function parseFightScript() {
    return parseFountainScript([
      'INT. VAULT - NIGHT',
      '',
      'The lights die. Everyone turns to BRIGGS.',
      '(A beat.)',
      '',
      'BRIGGS',
      'Nobody move.'
    ].join('\n'));
  }
});

test('a year is not an age', () => {
  const parsed = parseFountainScript([
    'INT. ARCHIVE - DAY',
    '',
    'REEVES (1950s newsreel flickering behind him) rewinds the tape.',
    '',
    'REEVES',
    'Watch this part.'
  ].join('\n'));

  assert.equal(introOf(parsed, 'REEVES').age, null);
  assert.equal(introOf(parsed, 'REEVES').text, '1950s newsreel flickering behind him');
});

test('an all-caps script keeps parentheticals and drops appositives', () => {
  const parsed = parseFountainScript([
    'INT. BRIDGE - NIGHT',
    '',
    'VALENTINE (30S, RUGGED, SOAKED THROUGH) GRIPS THE RAIL.',
    '',
    'MAYA, 32, A MEDIC, KNEELS BESIDE HIM.',
    '',
    'VALENTINE',
    'Hold on.',
    '',
    'MAYA',
    'I have you.'
  ].join('\n'));

  assert.equal(introOf(parsed, 'VALENTINE').text, '30S, RUGGED, SOAKED THROUGH');
  assert.equal(introOf(parsed, 'MAYA'), null);
});

test('an unclosed parenthesis does not swallow the rest of the scene', () => {
  const parsed = parseFountainScript([
    'INT. ATTIC - DAY',
    '',
    `NOLAN (40s, ${'a very long unterminated aside '.repeat(20)}`,
    '',
    'NOLAN',
    'Anyone up here?'
  ].join('\n'));

  assert.equal(introOf(parsed, 'NOLAN'), null);
});

test('a long description is truncated on a word boundary', () => {
  const parsed = parseFountainScript([
    'INT. STUDY - NIGHT',
    '',
    `PEMBERTON (70s, ${'frail and haughty and utterly unbearable '.repeat(6)}) coughs.`,
    '',
    'PEMBERTON',
    'Read the will.'
  ].join('\n'));

  const intro = introOf(parsed, 'PEMBERTON');
  assert.ok(intro.text.length <= 141, `got ${intro.text.length}`);
  assert.ok(intro.text.endsWith('…'));
  assert.equal(intro.text.includes('  '), false);
  assert.equal(intro.age, '70s');
});

test('extraction is idempotent', () => {
  const parsed = sample('midnight-manor');
  const before = parsed.characters.map(character => ({ ...character.introduction }));
  const again = findCharacterIntroductions(parsed);
  assert.deepEqual(
    parsed.characters.map(character => ({ ...again.get(character.name) })),
    before
  );
});

test('an introduction split across two extracted PDF rows is rejoined', async () => {
  const processExtractedLines = await loadPdfLineProcessor();
  const base = { page: 1, pageWidth: 612, pageHeight: 792 };
  const parsed = processExtractedLines([
    { ...base, y: 700, minX: 72, maxX: 400, text: 'MRS. HIGGINS (50s, nervous housekeeper,' },
    { ...base, y: 686, minX: 72, maxX: 400, text: 'trembling hands) sets down a silver tea tray.' },
    { ...base, y: 640, minX: 220, maxX: 300, text: 'MRS. HIGGINS' },
    { ...base, y: 626, minX: 180, maxX: 380, text: 'Will there be anything else?' }
  ], 'Manor');

  assert.equal(introOf(parsed, 'MRS. HIGGINS').text, '50s, nervous housekeeper, trembling hands');
});

test('page furniture between rows does not break an introduction', async () => {
  const processExtractedLines = await loadPdfLineProcessor();
  const base = { page: 1, pageWidth: 612, pageHeight: 792 };
  const parsed = processExtractedLines([
    { ...base, y: 700, minX: 72, maxX: 400, text: 'INSPECTOR BARKER (40s, sharp British tweed,' },
    { ...base, y: 686, minX: 72, maxX: 400, text: '(CONTINUED)' },
    { ...base, y: 672, minX: 72, maxX: 400, text: 'keen observant eyes) closes the doors.' },
    { ...base, y: 640, minX: 220, maxX: 320, text: 'INSPECTOR BARKER' },
    { ...base, y: 626, minX: 180, maxX: 380, text: 'Nobody leaves this room.' }
  ], 'Manor');

  assert.equal(
    introOf(parsed, 'INSPECTOR BARKER').text,
    '40s, sharp British tweed, keen observant eyes'
  );
});

test('a written pronoun outranks the name when suggesting a voice', () => {
  const parsed = sample('station-zero');
  const chen = parsed.characters.find(character => character.name === 'COMMANDER CHEN');

  // Nothing in "COMMANDER CHEN" reads female, so the name-only guess is male.
  const fromName = getSuggestedVoiceForCharacter(chen.name, {});
  assert.equal(getVoiceById(fromName).sex, 'Male');

  // "(30s, weary, grease on her forehead)" says otherwise, on the same line the
  // parser already walked past.
  const fromScript = getSuggestedVoiceForCharacter(chen.name, { introduction: chen.introduction });
  assert.equal(getVoiceById(fromScript).sex, 'Female');
});

test('a written age reaches the age-appropriate shortlist', () => {
  const elder = getSuggestedVoiceForCharacter('REEVES', {
    introduction: { text: '72, stooped, still sharp', age: '72' }
  });
  const young = getSuggestedVoiceForCharacter('REEVES', {
    introduction: { text: '15, a military brat in a hand-me-down jacket', age: '15' }
  });

  assert.notEqual(elder, young);
  assert.equal(elder, getSuggestedVoiceForCharacter('OLD REEVES', {}));
  assert.equal(young, getSuggestedVoiceForCharacter('YOUNG REEVES', {}));
});

test('a character with no introduction is cast exactly as before', () => {
  for (const name of ['CYPHER', 'ALICE', 'MRS. HIGGINS', 'THE STRANGER']) {
    assert.equal(
      getSuggestedVoiceForCharacter(name, { introduction: null }),
      getSuggestedVoiceForCharacter(name, {}),
      name
    );
  }
});

test('the cast rail shows the description and escapes it', () => {
  const dom = installDom();
  try {
    const scriptStore = castRailStore({
      name: 'HIGGINS',
      lineCount: 4,
      sampleLine: 'Tea, sir?',
      introduction: {
        text: '<img src=x onerror="window.pwned=1">',
        age: '50s',
        sourceText: 'HIGGINS (50s) sets down a tray.',
        elementId: 'line-1',
        form: 'parenthetical'
      }
    });

    const panel = createCastPanel({ scriptStore, audioManager: castRailAudio() });
    document.body.appendChild(panel.element);
    panel.render();

    assert.equal(panel.element.querySelector('.badge-age').textContent.trim(), '50s');
    assert.match(panel.element.querySelector('.char-intro-line').textContent, /<img src=x/);
    assert.equal(panel.element.querySelector('.char-intro-line img'), null);
    assert.equal(dom.window.pwned, undefined);
  } finally {
    removeDom(dom);
  }
});

function castRailStore(character) {
  return {
    currentScript: {
      title: 'Manor',
      characters: [character],
      elements: [{ type: 'DIALOGUE', character: character.name, text: character.sampleLine }]
    },
    castAssignments: new Map(),
    getNarratorVoice: () => 'bf_emma',
    subscribe: () => {},
    updateCharacterVoice() {},
    updateNarratorVoice() {}
  };
}

function castRailAudio() {
  return {
    engineId: ENGINE_IDS.KOKORO,
    capabilities: { supportsInstructions: false },
    getVoiceProfileForCharacter: () => ({ id: 'bf_emma' }),
    stop() {},
    setNarratorVoice() {},
    setVoiceAssignment() {}
  };
}

async function loadPdfLineProcessor() {
  globalThis.window = globalThis.window || {};
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix {};
  if (!globalThis.ImageData) globalThis.ImageData = class ImageData {};
  if (!globalThis.Path2D) globalThis.Path2D = class Path2D {};
  return (await import('../src/screenplay/pdf-parser.js')).processExtractedLines;
}

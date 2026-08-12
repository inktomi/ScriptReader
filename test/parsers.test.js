import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFountainScript } from '../src/screenplay/fountain-parser.js';
import { buildLineUnits, chunkSpeech } from '../src/audio/performance-director.js';
import { composeInstructions } from '../src/audio/instruction-composer.js';
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

test('a dual-dialogue cue stays continuous across a parenthetical', () => {
  const parsed = parseFountainScript([
    'ALICE',
    'I have an idea.',
    '',
    'BOB ^',
    'So do I—',
    '(whispering)',
    'and mine is better.'
  ].join('\n'));
  const bob = parsed.elements.filter(element => element.character === 'BOB');

  assert.equal(bob.length, 2);
  assert.equal(bob[0].overlap.mode, 'simultaneous');
  assert.equal(bob[1].overlap.mode, 'continuation');
});

test('Fountain forced-character cues keep mixed-case names as dialogue', () => {
  const parsed = parseFountainScript('@McCLANE\nWelcome to the party.');
  assert.equal(parsed.elements.length, 1);
  assert.equal(parsed.elements[0].type, 'DIALOGUE');
  assert.equal(parsed.elements[0].character, 'McCLANE');
  assert.equal(parsed.elements[0].text, 'Welcome to the party.');
});

test('explicit interruption cuts the victim while same-speaker dashes stay sequential', () => {
  const interrupted = parseFountainScript([
    'ALICE',
    'Let me finish this thought.',
    '',
    'BOB',
    '(interrupting)',
    'No.'
  ].join('\n'));
  assert.equal(interrupted.elements[0].cutOff, true);
  assert.equal(interrupted.elements[1].overlap.mode, 'interrupt');

  const sameSpeaker = parseFountainScript([
    'BOB',
    'I was going—',
    '',
    'BOB',
    '—to say yes.'
  ].join('\n'));
  assert.equal(sameSpeaker.elements[0].cutOff, false);
  assert.equal(sameSpeaker.elements[1].overlap, null);
});

async function loadPdfLineProcessor() {
  // pdf.js evaluates these browser constructors at module load even though the
  // line processor itself does not use them.
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix {};
  if (!globalThis.ImageData) globalThis.ImageData = class ImageData {};
  if (!globalThis.Path2D) globalThis.Path2D = class Path2D {};
  return (await import('../src/screenplay/pdf-parser.js')).processExtractedLines;
}

test('PDF dual columns become two simultaneous dialogue elements', async () => {
  const processExtractedLines = await loadPdfLineProcessor();
  const base = { page: 1, pageWidth: 612, pageHeight: 792 };
  const parsed = processExtractedLines([
    { ...base, y: 700, minX: 200, maxX: 245, text: 'ALICE' },
    { ...base, y: 700, minX: 380, maxX: 420, text: 'BOB' },
    { ...base, y: 682, minX: 160, maxX: 285, text: 'I vote we stay.' },
    { ...base, y: 682, minX: 350, maxX: 500, text: 'I vote we leave.' },
    { ...base, y: 640, minX: 72, maxX: 210, text: 'They stare at each other.' }
  ], 'Dual');
  const dialogue = parsed.elements.filter(element => element.type === 'DIALOGUE');

  assert.deepEqual(dialogue.map(element => element.character), ['ALICE', 'BOB']);
  assert.equal(dialogue[1].overlap.mode, 'simultaneous');
});

test('PDF uppercase dialogue and action do not become phantom speakers', async () => {
  const processExtractedLines = await loadPdfLineProcessor();
  const base = { page: 1, pageWidth: 612, pageHeight: 792 };
  const parsed = processExtractedLines([
    { ...base, y: 700, minX: 220, maxX: 260, text: 'BOB' },
    { ...base, y: 685, minX: 180, maxX: 220, text: 'RUN' },
    { ...base, y: 672, minX: 180, maxX: 310, text: 'before it sees us.' },
    { ...base, y: 630, minX: 72, maxX: 215, text: 'THE CAR EXPLODES' },
    { ...base, y: 615, minX: 72, maxX: 230, text: 'Flames fill the road.' }
  ], 'Action');

  assert.equal(parsed.characters.length, 1);
  assert.equal(parsed.characters[0].name, 'BOB');
  assert.equal(parsed.elements[0].text, 'RUN before it sees us.');
  assert.ok(parsed.elements.some(element => element.type === 'ACTION' && element.text === 'THE CAR EXPLODES'));
});

test('OpenAI keeps long speeches intact and uses exact transport speed', () => {
  const engine = {
    capabilities: {
      id: 'openai', supportsSpeed: true, supportsInstructions: true,
      usesInstructionPitch: true, maxChunkChars: 4096
    },
    resolveVoiceId: () => 'marin'
  };
  const text = `${'word '.repeat(180)}end.`;
  const units = buildLineUnits({
    element: { type: 'DIALOGUE', character: 'ALICE', text },
    voiceProfile: { id: 'marin', tone: 'Warm.', defaultPitch: 1, defaultSpeed: 1 },
    masterSpeed: 1.4,
    engine
  });

  assert.equal(units.length, 1);
  assert.equal(units[0].synthSpeed, 1.4);
  assert.equal(units[0].playbackRate, 1);
});

test('refreshing a Studio reference changes its render key without changing its voice id', () => {
  const engine = {
    capabilities: {
      id: 'chatterbox', supportsSpeed: false, supportsInstructions: false,
      maxChunkChars: 125
    },
    resolveVoiceId: profile => profile.id,
    resolveVoiceCacheId: profile => `${profile.id}@${profile.renderRevision}`
  };
  const args = {
    element: { type: 'DIALOGUE', character: 'ALICE', text: 'The same line.' },
    engine
  };
  const before = buildLineUnits({
    ...args,
    voiceProfile: { id: 'studio-alice', renderRevision: 1, defaultPitch: 1, defaultSpeed: 1 }
  })[0];
  const after = buildLineUnits({
    ...args,
    voiceProfile: { id: 'studio-alice', renderRevision: 2, defaultPitch: 1, defaultSpeed: 1 }
  })[0];

  assert.equal(before.voiceId, 'studio-alice');
  assert.equal(after.voiceId, 'studio-alice');
  assert.notEqual(before.key, after.key);
});

test('line-specific acting direction survives a pathological persona', () => {
  const instructions = composeInstructions({
    direction: 'x'.repeat(880),
    nuance: { emotionKey: 'whisper', directionText: 'whispering' },
    includeTempo: false
  });

  assert.ok(instructions.includes('Whisper.'));
  assert.ok(instructions.includes('Direction for this line: whispering.'));
  assert.ok(instructions.length <= 900);
});

test('interrupt trim and fade scale together with playback speed', () => {
  const engine = {
    capabilities: { id: 'openai', supportsSpeed: true, supportsInstructions: true, usesInstructionPitch: true, maxChunkChars: 4096 },
    resolveVoiceId: () => 'marin'
  };
  const args = {
    element: { type: 'DIALOGUE', character: 'ALICE', text: 'Do not cut me off.', cutOff: true },
    voiceProfile: { id: 'marin', defaultPitch: 1, defaultSpeed: 1 },
    engine
  };
  const slow = buildLineUnits({ ...args, masterSpeed: 0.5 })[0];
  const fast = buildLineUnits({ ...args, masterSpeed: 2 })[0];

  assert.equal(slow.trimTailSec / fast.trimTailSec, 4);
  assert.equal(slow.interruptFadeSec / fast.interruptFadeSec, 4);
});

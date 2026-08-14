import assert from 'node:assert/strict';
import test from 'node:test';
import { composeInstructions } from '../src/audio/instruction-composer.js';
import { buildLineUnits, chunkSpeech } from '../src/audio/performance-director.js';
import { cleanSpeechForSynthesis } from '../src/screenplay/emotion-analyzer.js';
import { parseFountainScript } from '../src/screenplay/fountain-parser.js';
import { isPdfDialogueContinuation, shouldSplitPdfDialogueAtParenthetical } from '../src/screenplay/pdf-layout.js';

test('titleless Fountain input keeps its opening scene and action', () => {
  const parsed = parseFountainScript(['INT. ROOM - DAY', 'A lamp flickers.', '', 'BOB', 'Hello.'].join('\n'));

  assert.equal(parsed.elements[0].type, 'SCENE_HEADING');
  assert.equal(parsed.elements[0].text, 'INT. ROOM - DAY');
  assert.equal(parsed.elements[1].type, 'ACTION');
  assert.equal(parsed.elements[1].text, 'A lamp flickers.');
});

test('uppercase action ending in punctuation is not treated as a character cue', () => {
  const parsed = parseFountainScript('THE DOOR EXPLODES.\nSmoke fills the room.');
  assert.deepEqual(
    parsed.elements.map((element) => element.type),
    ['ACTION', 'ACTION'],
  );
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
  assert.deepEqual(
    parsed.elements.map((element) => element.type),
    ['ACTION', 'ACTION'],
  );
  assert.equal(parsed.characters.length, 0);
});

test('speech chunks never exceed the engine limit, even without punctuation or commas', () => {
  const chunks = chunkSpeech('word '.repeat(120), 190);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 190));
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
  const parsed = parseFountainScript(
    ['ALICE', 'I have an idea.', '', 'BOB ^', 'So do I—', '(whispering)', 'and mine is better.'].join('\n'),
  );
  const bob = parsed.elements.filter((element) => element.character === 'BOB');

  assert.equal(bob.length, 2);
  assert.equal(bob[0].overlap.mode, 'simultaneous');
  assert.equal(bob[1].overlap.mode, 'continuation');
});

// A cue with two extensions is ordinary — and a PDF is persisted by round-tripping
// through Fountain, so every `(O.S.) (CONT'D)` in an imported script came back as
// narrator-read action on reload, quietly rewriting the cast list.
test('a character cue carrying two extensions is still a cue', () => {
  const parsed = parseFountainScript('BARRETT (O.S.) (CONT’D)\nPut her with the rest.');
  assert.equal(parsed.elements.length, 1);
  assert.equal(parsed.elements[0].type, 'DIALOGUE');
  assert.equal(parsed.elements[0].character, 'BARRETT');
});

test('a joint Fountain cue speaks as both characters at once', () => {
  const parsed = parseFountainScript(
    ['CICI', 'Where are we?', '', 'MAYA', 'No idea.', '', 'CICI AND MAYA', 'Holy shit.'].join('\n'),
  );

  assert.deepEqual(
    parsed.characters.map((character) => character.name),
    ['CICI', 'MAYA'],
  );
  const shared = parsed.elements.filter((element) => element.text === 'Holy shit.');
  assert.deepEqual(
    shared.map((element) => element.character),
    ['CICI', 'MAYA'],
  );
  assert.equal(shared[0].overlap, null);
  assert.equal(shared[1].overlap.mode, 'simultaneous');
  assert.equal(shared[1].overlap.source, 'shared-cue');
});

// The safety rule: without a solo cue for each half there is no evidence this is
// two people rather than one oddly-named one, and inventing cast is the worse error.
test('a joint cue whose halves never speak alone stays one character', () => {
  const parsed = parseFountainScript('GUARD ONE AND GUARD TWO\nHalt.');
  assert.deepEqual(
    parsed.characters.map((character) => character.name),
    ['GUARD ONE AND GUARD TWO'],
  );
});

test('a name that merely contains AND is never split', () => {
  const parsed = parseFountainScript(['ALEX', 'Ready.', '', 'ANDER', 'Ready.', '', 'ALEXANDER', 'Then go.'].join('\n'));
  assert.ok(parsed.characters.some((character) => character.name === 'ALEXANDER'));
});

// Splitting each fragment on its own leaves CICI following MAYA across a trailing
// dash, which `annotateScriptFlow` reads as one half of the pair interrupting the
// other half of its own line.
test('a joint cue split by a direction does not interrupt itself', () => {
  const parsed = parseFountainScript(
    [
      'CICI',
      'Where are we?',
      '',
      'MAYA',
      'No idea.',
      '',
      'CICI AND MAYA',
      'Holy shit—',
      '(whispering)',
      'what was that?',
    ].join('\n'),
  );
  const shared = parsed.elements.slice(2);

  assert.deepEqual(
    shared.map((element) => [element.character, element.overlap && element.overlap.mode]),
    [
      ['CICI', null],
      ['MAYA', 'simultaneous'],
      ['CICI', 'continuation'],
      ['MAYA', 'simultaneous'],
    ],
  );
  assert.ok(shared.every((element) => element.cutOff === false));
  assert.equal(shared[2].parenthetical, 'whispering');
  assert.notEqual(shared[2].nuance, shared[3].nuance);
});

test('interrupting a joint cue cuts off every speaker sharing it', () => {
  const parsed = parseFountainScript(
    [
      'CICI',
      'Where are we?',
      '',
      'MAYA',
      'No idea.',
      '',
      'CICI AND MAYA',
      'Holy shit—',
      '',
      'BARRETT',
      '(interrupting)',
      'Enough.',
    ].join('\n'),
  );
  const shared = parsed.elements.slice(2, 4);

  assert.deepEqual(
    shared.map((element) => element.character),
    ['CICI', 'MAYA'],
  );
  assert.ok(shared.every((element) => element.cutOff === true));
  assert.equal(parsed.elements[4].overlap.mode, 'interrupt');
});

test('a joint cue gives each speaker the extensions the cue carried', () => {
  const parsed = parseFountainScript(
    ['CICI', 'Where are we?', '', 'MAYA', 'No idea.', '', 'CICI AND MAYA (CONT’D)', 'Holy shit.'].join('\n'),
  );
  const shared = parsed.elements.slice(2);

  assert.deepEqual(
    shared.map((element) => element.characterOriginal),
    ['CICI (CONT’D)', 'MAYA (CONT’D)'],
  );
});

test('Fountain forced-character cues keep mixed-case names as dialogue', () => {
  const parsed = parseFountainScript('@McCLANE\nWelcome to the party.');
  assert.equal(parsed.elements.length, 1);
  assert.equal(parsed.elements[0].type, 'DIALOGUE');
  assert.equal(parsed.elements[0].character, 'McCLANE');
  assert.equal(parsed.elements[0].text, 'Welcome to the party.');
});

test('explicit interruption cuts the victim while same-speaker dashes stay sequential', () => {
  const interrupted = parseFountainScript(
    ['ALICE', 'Let me finish this thought.', '', 'BOB', '(interrupting)', 'No.'].join('\n'),
  );
  assert.equal(interrupted.elements[0].cutOff, true);
  assert.equal(interrupted.elements[1].overlap.mode, 'interrupt');

  const sameSpeaker = parseFountainScript(['BOB', 'I was going—', '', 'BOB', '—to say yes.'].join('\n'));
  assert.equal(sameSpeaker.elements[0].cutOff, false);
  assert.equal(sameSpeaker.elements[1].overlap, null);
});

async function loadPdfParser() {
  // pdf.js evaluates these browser constructors at module load even though the
  // line processor itself does not use them.
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix {};
  if (!globalThis.ImageData) globalThis.ImageData = class ImageData {};
  if (!globalThis.Path2D) globalThis.Path2D = class Path2D {};
  return import('../src/screenplay/pdf-parser.js');
}

async function loadPdfLineProcessor() {
  return (await loadPdfParser()).processExtractedLines;
}

/** Smallest PDF that still carries positioned text, so the reader runs for real. */
function buildTextPdf(contentStream) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]' +
      ' /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n',
    `5 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  return Uint8Array.from(pdf, (char) => char.charCodeAt(0)).buffer;
}

// The reader tears the document down in a `finally`, so a teardown that throws
// discards an already-finished screenplay. That is how a `destroy()` pdf.js had
// removed turned every readable PDF into "could not be read".
test('a readable PDF survives the reader releasing the document', async () => {
  const { parsePdfScreenplay } = await loadPdfParser();
  const parsed = await parsePdfScreenplay(
    buildTextPdf(
      'BT /F1 12 Tf 108 700 Td (INT. DINER - NIGHT) Tj' +
        ' 0 -24 Td (A cook wipes the counter.) Tj' +
        ' 100 -24 Td (SAM) Tj -64 -14 Td (We are open.) Tj ET',
    ),
  );

  assert.deepEqual(
    parsed.elements.map((element) => [element.type, element.character, element.text]),
    [
      ['SCENE_HEADING', 'NARRATOR', 'INT. DINER - NIGHT'],
      ['ACTION', 'NARRATOR', 'A cook wipes the counter.'],
      ['DIALOGUE', 'SAM', 'We are open.'],
    ],
  );
});

test('an unreadable PDF reports why it failed rather than how cleanup went', async () => {
  const { parsePdfScreenplay } = await loadPdfParser();
  await assert.rejects(parsePdfScreenplay(Uint8Array.from([1, 2, 3, 4, 5]).buffer), /Invalid PDF structure/);
});

test('PDF dual columns become two simultaneous dialogue elements', async () => {
  const processExtractedLines = await loadPdfLineProcessor();
  const base = { page: 1, pageWidth: 612, pageHeight: 792 };
  const parsed = processExtractedLines(
    [
      { ...base, y: 700, minX: 200, maxX: 245, text: 'ALICE' },
      { ...base, y: 700, minX: 380, maxX: 420, text: 'BOB' },
      { ...base, y: 682, minX: 160, maxX: 285, text: 'I vote we stay.' },
      { ...base, y: 682, minX: 350, maxX: 500, text: 'I vote we leave.' },
      { ...base, y: 640, minX: 72, maxX: 210, text: 'They stare at each other.' },
    ],
    'Dual',
  );
  const dialogue = parsed.elements.filter((element) => element.type === 'DIALOGUE');

  assert.deepEqual(
    dialogue.map((element) => element.character),
    ['ALICE', 'BOB'],
  );
  assert.equal(dialogue[1].overlap.mode, 'simultaneous');
});

test('PDF uppercase dialogue and action do not become phantom speakers', async () => {
  const processExtractedLines = await loadPdfLineProcessor();
  const base = { page: 1, pageWidth: 612, pageHeight: 792 };
  const parsed = processExtractedLines(
    [
      { ...base, y: 700, minX: 220, maxX: 260, text: 'BOB' },
      { ...base, y: 685, minX: 180, maxX: 220, text: 'RUN' },
      { ...base, y: 672, minX: 180, maxX: 310, text: 'before it sees us.' },
      { ...base, y: 630, minX: 72, maxX: 215, text: 'THE CAR EXPLODES' },
      { ...base, y: 615, minX: 72, maxX: 230, text: 'Flames fill the road.' },
    ],
    'Action',
  );

  assert.equal(parsed.characters.length, 1);
  assert.equal(parsed.characters[0].name, 'BOB');
  assert.equal(parsed.elements[0].text, 'RUN before it sees us.');
  assert.ok(parsed.elements.some((element) => element.type === 'ACTION' && element.text === 'THE CAR EXPLODES'));
});

// The cue detector is geometric — centred, upper case, short, text underneath —
// and a cover page is exactly that shape, so the film's title became a speaker
// and the writer's email became something the narrator read out loud.
test('a PDF cover page never becomes a cast member', async () => {
  const processExtractedLines = await loadPdfLineProcessor();
  const cover = { page: 1, pageWidth: 612, pageHeight: 792 };
  const body = { page: 3, pageWidth: 612, pageHeight: 792 };
  const parsed = processExtractedLines(
    [
      { ...cover, y: 507, minX: 250, maxX: 362, text: 'MIDNIGHT CARAVAN' },
      { ...cover, y: 459, minX: 271, maxX: 341, text: 'Written by' },
      { ...cover, y: 423, minX: 260, maxX: 351, text: 'Efrain Franco' },
      { ...cover, y: 111, minX: 72, maxX: 191, text: 'effie85@gmail.com' },
      { ...cover, y: 99, minX: 72, maxX: 156, text: 'WGA #2227534' },
      { page: 2, pageWidth: 612, pageHeight: 792, y: 747, minX: 501, maxX: 522, text: 'ii.' },
      { ...body, y: 711, minX: 108, maxX: 164, text: 'FADE IN:' },
      { ...body, y: 675, minX: 108, maxX: 332, text: 'INT. DINER - NIGHT' },
      { ...body, y: 651, minX: 108, maxX: 332, text: 'A cook wipes the counter.' },
    ],
    'Midnight_Caravan',
  );

  assert.deepEqual(parsed.characters, []);
  assert.deepEqual(
    parsed.elements.map((element) => [element.type, element.text]),
    [
      ['TRANSITION', 'FADE IN:'],
      ['SCENE_HEADING', 'INT. DINER - NIGHT'],
      ['ACTION', 'A cook wipes the counter.'],
    ],
  );
  // The cover says what the file name only approximates.
  assert.equal(parsed.title, 'MIDNIGHT CARAVAN');
});

// The cut is made at a page edge rather than at the marker, because a screenplay
// is allowed to open on something before its first slug line.
test('action before the first slug line is not mistaken for a cover page', async () => {
  const processExtractedLines = await loadPdfLineProcessor();
  const base = { page: 1, pageWidth: 612, pageHeight: 792 };
  const parsed = processExtractedLines(
    [
      { ...base, y: 711, minX: 108, maxX: 300, text: 'BLACK SCREEN.' },
      { ...base, y: 687, minX: 108, maxX: 320, text: 'A voice, unseen.' },
      { ...base, y: 663, minX: 108, maxX: 332, text: 'INT. CAR - DAY' },
    ],
    'Opening',
  );

  assert.deepEqual(
    parsed.elements.map((element) => element.text),
    ['BLACK SCREEN.', 'A voice, unseen.', 'INT. CAR - DAY'],
  );
  assert.equal(parsed.title, 'Opening');
});

test('a joint PDF cue speaks as both characters and keeps the scene index honest', async () => {
  const processExtractedLines = await loadPdfLineProcessor();
  const base = { page: 1, pageWidth: 612, pageHeight: 792 };
  const parsed = processExtractedLines(
    [
      { ...base, y: 700, minX: 252, maxX: 273, text: 'CICI' },
      { ...base, y: 688, minX: 180, maxX: 260, text: 'Where are we?' },
      { ...base, y: 664, minX: 252, maxX: 280, text: 'MAYA' },
      { ...base, y: 652, minX: 180, maxX: 250, text: 'No idea.' },
      { ...base, y: 628, minX: 252, maxX: 345, text: 'CICI AND MAYA' },
      { ...base, y: 616, minX: 180, maxX: 250, text: 'Holy shit.' },
      { ...base, y: 580, minX: 108, maxX: 300, text: 'EXT. GHOST TOWN - SAME' },
    ],
    'Joint',
  );

  assert.deepEqual(
    parsed.characters.map((character) => [character.name, character.lineCount]),
    [
      ['CICI', 2],
      ['MAYA', 2],
    ],
  );
  const shared = parsed.elements.filter((element) => element.text === 'Holy shit.');
  assert.deepEqual(
    shared.map((element) => element.character),
    ['CICI', 'MAYA'],
  );
  assert.equal(shared[1].overlap.mode, 'simultaneous');

  // Renumbering and the scene remap travel together: the drawer jumps by index.
  assert.ok(parsed.elements.every((element, index) => element.id === `line-${index}`));
  const lastScene = parsed.scenes[parsed.scenes.length - 1];
  assert.equal(parsed.elements[lastScene.lineIndex].type, 'SCENE_HEADING');
  assert.equal(parsed.elements[lastScene.lineIndex].text, 'EXT. GHOST TOWN - SAME');
});

test('OpenAI keeps long speeches intact and uses exact transport speed', () => {
  const engine = {
    capabilities: {
      id: 'openai',
      supportsSpeed: true,
      supportsInstructions: true,
      usesInstructionPitch: true,
      maxChunkChars: 4096,
    },
    resolveVoiceId: () => 'marin',
  };
  const text = `${'word '.repeat(180)}end.`;
  const units = buildLineUnits({
    element: { type: 'DIALOGUE', character: 'ALICE', text },
    voiceProfile: { id: 'marin', tone: 'Warm.', defaultPitch: 1, defaultSpeed: 1 },
    masterSpeed: 1.4,
    engine,
  });

  assert.equal(units.length, 1);
  assert.equal(units[0].synthSpeed, 1.4);
  assert.equal(units[0].playbackRate, 1);
});

test('refreshing a Studio reference changes its render key without changing its voice id', () => {
  const engine = {
    capabilities: {
      id: 'chatterbox',
      supportsSpeed: false,
      supportsInstructions: false,
      maxChunkChars: 125,
    },
    resolveVoiceId: (profile) => profile.id,
    resolveVoiceCacheId: (profile) => `${profile.id}@${profile.renderRevision}`,
  };
  const args = {
    element: { type: 'DIALOGUE', character: 'ALICE', text: 'The same line.' },
    engine,
  };
  const before = buildLineUnits({
    ...args,
    voiceProfile: { id: 'studio-alice', renderRevision: 1, defaultPitch: 1, defaultSpeed: 1 },
  })[0];
  const after = buildLineUnits({
    ...args,
    voiceProfile: { id: 'studio-alice', renderRevision: 2, defaultPitch: 1, defaultSpeed: 1 },
  })[0];

  assert.equal(before.voiceId, 'studio-alice');
  assert.equal(after.voiceId, 'studio-alice');
  assert.equal(before.voiceCacheId, 'studio-alice@1');
  assert.equal(after.voiceCacheId, 'studio-alice@2');
  assert.notEqual(before.key, after.key);
});

test('line-specific acting direction survives a pathological persona', () => {
  const instructions = composeInstructions({
    direction: 'x'.repeat(880),
    nuance: { emotionKey: 'whisper', directionText: 'whispering' },
    includeTempo: false,
  });

  assert.ok(instructions.includes('Whisper.'));
  assert.ok(instructions.includes('Direction for this line: whispering.'));
  assert.ok(instructions.length <= 900);
});

test('interrupt trim and fade scale together with playback speed', () => {
  const engine = {
    capabilities: {
      id: 'openai',
      supportsSpeed: true,
      supportsInstructions: true,
      usesInstructionPitch: true,
      maxChunkChars: 4096,
    },
    resolveVoiceId: () => 'marin',
  };
  const args = {
    element: { type: 'DIALOGUE', character: 'ALICE', text: 'Do not cut me off.', cutOff: true },
    voiceProfile: { id: 'marin', defaultPitch: 1, defaultSpeed: 1 },
    engine,
  };
  const slow = buildLineUnits({ ...args, masterSpeed: 0.5 })[0];
  const fast = buildLineUnits({ ...args, masterSpeed: 2 })[0];

  assert.equal(slow.trimTailSec / fast.trimTailSec, 4);
  assert.equal(slow.interruptFadeSec / fast.interruptFadeSec, 4);
});

test('buildLineUnits returns an empty array for lines without speakable dialogue or action', () => {
  const engine = {
    capabilities: {
      id: 'chatterbox',
      supportsSpeed: false,
      supportsInstructions: false,
      maxChunkChars: 125,
    },
    resolveVoiceId: (profile) => profile.id,
    resolveVoiceCacheId: (profile) => profile.id,
  };
  const voiceProfile = { id: 'test-voice', defaultPitch: 1, defaultSpeed: 1 };

  const unspeakableTexts = [
    '(beat)',
    '(pause)',
    '(sighs)',
    '(laughing)',
    '...',
    '--',
    '---',
    '—',
    '[[pace: rapid]]',
    '(CONTINUED)',
    "(cont'd)",
    '   ',
    '',
    '!?',
  ];

  for (const text of unspeakableTexts) {
    const units = buildLineUnits({
      element: { type: 'DIALOGUE', character: 'ALICE', text },
      voiceProfile,
      engine,
    });
    assert.equal(units.length, 0, `Expected 0 units for unspeakable text: ${JSON.stringify(text)}`);
  }

  // Lines with actual dialogue alongside parentheticals should still generate valid units
  const spokenUnits = buildLineUnits({
    element: { type: 'DIALOGUE', character: 'ALICE', text: '(beat) Hello world!' },
    voiceProfile,
    engine,
  });
  assert.equal(spokenUnits.length, 1);
  assert.equal(spokenUnits[0].text, 'Hello world!');
});

test('chunkSpeech handles smart quotes and never produces non-alphanumeric orphan chunks', () => {
  const quoteTests = [
    '“CHOKE ON YOUR PRIDE, YOU DEVIL-WHORE.”',
    '“LeVal.”',
    'CANDIDATE’S SON’S CAMPAIGN.”',
    'them to “Lantern City.”',
    '“Wait!” she shouted. “Don’t go!”',
    'He whispered: ‘Run.’',
  ];

  for (const text of quoteTests) {
    const chunks = chunkSpeech(text, 125);
    assert.ok(chunks.length > 0, `Expected chunks for: ${text}`);
    for (const chunk of chunks) {
      assert.ok(
        /[a-z0-9]/i.test(chunk),
        `Chunk must contain alphanumeric characters, got: ${JSON.stringify(chunk)} from ${JSON.stringify(text)}`,
      );
    }
  }

  // Pure punctuation or symbols should return an empty array
  assert.deepEqual(chunkSpeech('”', 125), []);
  assert.deepEqual(chunkSpeech('“ ”', 125), []);
  assert.deepEqual(chunkSpeech('... -- !?', 125), []);
});

test('cleanSpeechForSynthesis normalizes terminal punctuation and ellipses within quotes', () => {
  assert.equal(cleanSpeechForSynthesis('“Hello...”'), '“Hello.”');
  assert.equal(cleanSpeechForSynthesis('"Hello..."'), '"Hello."');
  assert.equal(cleanSpeechForSynthesis('“Hello—”'), '“Hello.”');
  assert.equal(cleanSpeechForSynthesis('"Hello—"'), '"Hello."');
  assert.equal(cleanSpeechForSynthesis('“Hello—”', 'CHARACTER', { cutOff: true }), '“Hello”');
});

import { attachCharacterIntroductions } from './character-introductions.js';
import { analyzeLineNuance } from './emotion-analyzer.js';
import { annotateScriptFlow, DEFAULT_PACE, parsePaceDirective } from './overlap-pacing.js';
import { expandSharedDialogueCues } from './shared-cues.js';

/**
 * Screenplay Parser for Fountain, Final Draft text, and plain screenplay formats.
 * Converts raw screenplay text into structured script elements with nuance metadata.
 */

export function parseFountainScript(text) {
  if (!text) return { title: 'Untitled Screenplay', elements: [], characters: [], scenes: [] };

  const lines = text.split(/\r?\n/);
  const elements = [];
  const characterSet = new Map(); // name -> { count, lines }
  const sceneList = [];

  let scriptTitle = 'Screenplay';
  let currentSceneNumber = 0;
  let currentSceneTitle = 'Scene 1';
  let currentSpeaker = null;
  let currentSpeakerOriginal = null;
  let currentParenthetical = '';
  let lineIndex = 0;
  // Pace runs from a `[[pace: ...]]` note until the next one or the next scene.
  let activePace = DEFAULT_PACE;
  // Set by a `^` on the character cue. A parenthetical may split one cue into
  // multiple elements, so later fragments continue from the first rather than
  // losing the cue's overlap relationship.
  let pendingDual = null;

  // Check for Title Page metadata (e.g. Title: ..., Author: ...)
  let startLine = 0;
  let inTitlePage = true;
  let sawTitlePageField = false;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const l = lines[i].trim();
    if (/^Title:\s*(.+)$/i.test(l)) {
      scriptTitle = l.replace(/^Title:\s*/i, '').trim();
    }
    if (/^(Title|Author|Authors|Credit|Source|Draft date|Contact|Copyright):/i.test(l)) {
      sawTitlePageField = true;
    }
    if (inTitlePage && l === '' && sawTitlePageField) {
      startLine = i + 1;
      inTitlePage = false;
      break;
    }
    if (inTitlePage && l === '' && !sawTitlePageField) break;
  }

  // Regex patterns for screenplay elements (fixed word boundary on dots)
  const SCENE_REGEX =
    /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.|EST\.|INT\s|EXT\s|SCENE\s+\d+|PROLOGUE|EPILOGUE)(\s+|$)/i;
  const TRANSITION_REGEX =
    /^(CUT TO:|FADE IN:|FADE OUT\.|FADE TO BLACK\.|DISSOLVE TO:|SMASH CUT TO:|MATCH CUT TO:|JUMP CUT TO:|>.*<)$/i;
  const PARENTHETICAL_REGEX = /^\s*\((.+)\)\s*$/;
  // The trailing `^` is Fountain's dual dialogue marker. It has to be part of
  // the pattern or a cue carrying one is not recognised as a cue at all.
  // Extensions repeat: `BARRETT (O.S.) (CONT'D)` is ordinary, and a PDF that gets
  // round-tripped through Fountain to be persisted is full of them. Allowing only
  // one turned that cue and its whole speech into narrator-read action on reload.
  const CHARACTER_REGEX = /^\s*([A-Za-z0-9\s._'-]+?)(\s*\([^)]*\))*\s*(\^)?\s*$/;

  let inDialogueBlock = false;
  let pendingDialogueLines = [];
  // Action is a paragraph, not a line. Fountain ends one at a blank line and at
  // nothing else, so every hard wrap inside a block is the author's text editor
  // talking, not the author. Emitting one element per physical line made the
  // narrator stop at each wrap — mid-sentence, wherever the margin happened to
  // fall — and asked the emotion analyzer to read a fragment as if it were a
  // whole thought.
  let pendingActionLines = [];

  function flushAction() {
    if (pendingActionLines.length === 0) return;
    const paragraph = pendingActionLines.join(' ').trim();
    pendingActionLines = [];
    if (!paragraph) return;

    elements.push({
      id: `line-${lineIndex++}`,
      type: 'ACTION',
      sceneNumber: currentSceneNumber || 1,
      sceneTitle: currentSceneTitle,
      character: 'NARRATOR',
      characterOriginal: 'NARRATOR',
      text: paragraph,
      parenthetical: '',
      pace: activePace,
      linePace: null,
      overlap: null,
      cutOff: false,
      nuance: analyzeLineNuance({ text: paragraph, speakerType: 'ACTION' }),
    });
  }

  function flushDialogue({ preserveCue = false } = {}) {
    if (pendingDialogueLines.length > 0 && currentSpeaker) {
      const fullDialogueText = pendingDialogueLines.join(' ').trim();
      // The cue extension — (V.O.), (O.S.) — decides whether this voice is in the
      // room, on a speaker, or off-screen, so it has to reach the analyzer.
      const extensionMatch = (currentSpeakerOriginal || '').match(/\([^)]*\)/g);
      const nuance = analyzeLineNuance({
        text: fullDialogueText,
        parenthetical: currentParenthetical,
        speakerType: 'CHARACTER',
        extension: extensionMatch ? extensionMatch.join(' ') : '',
      });

      const element = {
        id: `line-${lineIndex++}`,
        type: 'DIALOGUE',
        sceneNumber: currentSceneNumber || 1,
        sceneTitle: currentSceneTitle,
        character: currentSpeaker,
        characterOriginal: currentSpeakerOriginal || currentSpeaker,
        text: fullDialogueText,
        parenthetical: currentParenthetical,
        pace: activePace,
        linePace: null,
        overlap:
          pendingDual === 'simultaneous'
            ? { mode: 'simultaneous', withPrevious: true, offsetMs: null, source: 'caret' }
            : pendingDual === 'continuation'
              ? { mode: 'continuation', withPrevious: true, offsetMs: 0, source: 'parenthetical' }
              : null,
        cutOff: false,
        nuance,
      };

      elements.push(element);

      // Track character stats
      if (!characterSet.has(currentSpeaker)) {
        characterSet.set(currentSpeaker, { name: currentSpeaker, count: 0, sampleLine: fullDialogueText });
      }
      characterSet.get(currentSpeaker).count++;

      pendingDialogueLines = [];
      currentParenthetical = '';
      pendingDual = preserveCue && pendingDual ? 'continuation' : null;
    }
    if (!preserveCue && pendingDialogueLines.length === 0) pendingDual = null;
  }

  for (let idx = startLine; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trim();

    // Skip empty lines
    if (!trimmed) {
      flushAction();
      flushDialogue();
      inDialogueBlock = false;
      continue;
    }

    // Ignore title block tags if still present
    if (/^(Title|Author|Authors|Credit|Source|Draft date|Contact|Copyright):/i.test(trimmed)) {
      continue;
    }

    // Fountain notes [[ ... ]] are not spoken, but a pace directive in one is
    // the author telling us how the passage that follows should run.
    if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
      const pace = parsePaceDirective(trimmed.slice(2, -2));
      if (pace) {
        // Before `activePace` moves: the paragraph that just ended ran at the
        // pace in force while it was being read, not the one starting here.
        flushAction();
        flushDialogue();
        inDialogueBlock = false;
        activePace = pace;
      }
      continue;
    }

    // 1. Scene Headings (e.g. EXT. OMNICORP SPIRE - 80TH FLOOR LEDGE - NIGHT)
    if (SCENE_REGEX.test(trimmed) || (trimmed.startsWith('.') && trimmed.length > 1 && !trimmed.startsWith('..'))) {
      flushAction();
      flushDialogue();
      inDialogueBlock = false;
      currentSpeaker = null;

      // A new scene is a clean slate; a pace set inside the last one does not
      // leak across the cut.
      activePace = DEFAULT_PACE;

      currentSceneNumber++;
      currentSceneTitle = trimmed.replace(/^\./, '').trim();
      sceneList.push({ number: currentSceneNumber, title: currentSceneTitle, lineIndex });

      const nuance = analyzeLineNuance({
        text: currentSceneTitle,
        speakerType: 'SCENE_HEADING',
      });

      elements.push({
        id: `line-${lineIndex++}`,
        type: 'SCENE_HEADING',
        sceneNumber: currentSceneNumber,
        sceneTitle: currentSceneTitle,
        character: 'NARRATOR',
        characterOriginal: 'NARRATOR (SCENE)',
        text: currentSceneTitle,
        parenthetical: '',
        pace: activePace,
        linePace: null,
        overlap: null,
        cutOff: false,
        nuance,
      });
      continue;
    }

    // 2. Transitions (e.g. CUT TO:)
    if (TRANSITION_REGEX.test(trimmed)) {
      flushAction();
      flushDialogue();
      inDialogueBlock = false;
      currentSpeaker = null;

      const nuance = analyzeLineNuance({
        text: trimmed,
        speakerType: 'TRANSITION',
      });

      elements.push({
        id: `line-${lineIndex++}`,
        type: 'TRANSITION',
        sceneNumber: currentSceneNumber || 1,
        sceneTitle: currentSceneTitle,
        character: 'NARRATOR',
        characterOriginal: 'NARRATOR',
        text: trimmed.replace(/^>|<$/g, '').trim(),
        parenthetical: '',
        pace: activePace,
        linePace: null,
        overlap: null,
        cutOff: false,
        nuance,
      });
      continue;
    }

    // 3. Parentheticals (e.g. (whispering))
    const parenMatch = trimmed.match(PARENTHETICAL_REGEX);
    if (parenMatch && (inDialogueBlock || currentSpeaker)) {
      if (pendingDialogueLines.length > 0) {
        flushDialogue({ preserveCue: true });
        inDialogueBlock = true;
      }
      currentParenthetical = parenMatch[1];
      continue;
    }

    // 4. Character Cue (e.g. SARAH (O.S.))
    // Standard screenplay rules: Uppercase name, preceded by empty line, not a scene heading or transition
    const forcedCharacter = trimmed.startsWith('@');
    const cueText = forcedCharacter ? trimmed.slice(1).trim() : trimmed;
    const charMatch = cueText.match(CHARACTER_REGEX);
    const looksLikeInitials = /^(?:[A-Z]\.\s*){2,}(?:[A-Z][A-Z0-9_' -]*\.?)?$/.test(cueText);
    const looksLikeAbbreviatedName =
      /^(?:DR|MR|MRS|MS|PROF|CAPT|LT|SGT|GEN|COL|REV)\.$/.test(cueText) ||
      /^(?:[A-Z][A-Z0-9_'-]*\s+){1,2}(?:JR|SR)\.$/.test(cueText);
    const isLikelyCharacter =
      charMatch &&
      !inDialogueBlock &&
      cueText.length < 38 &&
      (forcedCharacter || cueText === cueText.toUpperCase()) &&
      !cueText.includes('!') &&
      !cueText.includes('?') &&
      (forcedCharacter || !/\.$/.test(cueText) || looksLikeInitials || looksLikeAbbreviatedName) &&
      !SCENE_REGEX.test(cueText) &&
      !TRANSITION_REGEX.test(cueText);

    if (isLikelyCharacter) {
      flushAction();
      flushDialogue();
      inDialogueBlock = true;
      // The caret is a staging instruction, not part of the name — keep it out
      // of the cue the teleprompter shows and out of the extension parsing.
      pendingDual = charMatch[3] ? 'simultaneous' : null;
      currentSpeakerOriginal = cueText.replace(/\s*\^\s*$/, '').trim();
      // Strip extensions like (V.O.), (O.S.), (CONT'D), (INTO PHONE)
      currentSpeaker = charMatch[1].replace(/\s*\([^)]*\)\s*/g, '').trim();
      currentParenthetical = '';
      continue;
    }

    // 5. Dialogue vs Action
    if (inDialogueBlock && currentSpeaker) {
      pendingDialogueLines.push(trimmed);
    } else {
      // Action / Description block (read by Narrator). Held until something
      // ends the paragraph rather than emitted here, so a wrapped block reaches
      // the narrator as the one continuous passage it is on the page.
      flushDialogue();
      currentSpeaker = null;
      pendingActionLines.push(trimmed);
    }
  }

  flushAction();
  flushDialogue();

  // Always ensure Narrator is in character list
  const characters = Array.from(characterSet.values()).map((c) => ({
    name: c.name,
    lineCount: c.count,
    sampleLine: c.sampleLine,
  }));

  // Sort characters by line count descending
  characters.sort((a, b) => b.lineCount - a.lineCount);

  // Overlap is a relationship between neighbours, which only the finished array
  // can see. So is a character's introduction, which sits in the action rather
  // than in anything that character says — but that pass stays outside
  // `annotateScriptFlow`, whose whole job is to rewrite elements. Composing the
  // two keeps "introductions never touch elements" visible at the call site.
  // Shared cues run innermost: splitting `CICI AND MAYA` creates the very
  // adjacency `annotateScriptFlow` exists to resolve, so it has to happen first.
  return attachCharacterIntroductions(
    annotateScriptFlow(
      expandSharedDialogueCues({
        title: scriptTitle,
        elements,
        characters,
        scenes: sceneList,
        totalLines: elements.length,
      }),
    ),
  );
}

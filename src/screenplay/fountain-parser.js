import { analyzeLineNuance } from './emotion-analyzer.js';

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

  // Check for Title Page metadata (e.g. Title: ..., Author: ...)
  let startLine = 0;
  let inTitlePage = true;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const l = lines[i].trim();
    if (/^Title:\s*(.+)$/i.test(l)) {
      scriptTitle = l.replace(/^Title:\s*/i, '').trim();
    }
    if (inTitlePage && l === '') {
      startLine = i + 1;
      inTitlePage = false;
      break;
    }
  }

  // Regex patterns for screenplay elements (fixed word boundary on dots)
  const SCENE_REGEX = /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.|EST\.|INT\s|EXT\s|SCENE\s+\d+|PROLOGUE|EPILOGUE)(\s+|$)/i;
  const TRANSITION_REGEX = /^(CUT TO:|FADE IN:|FADE OUT\.|FADE TO BLACK\.|DISSOLVE TO:|SMASH CUT TO:|MATCH CUT TO:|JUMP CUT TO:|>.*<)$/i;
  const PARENTHETICAL_REGEX = /^\s*\((.+)\)\s*$/;
  const CHARACTER_REGEX = /^\s*([A-Z0-9\s._'-]+?)(\s*\(.*\))?\s*$/;

  let inDialogueBlock = false;
  let pendingDialogueLines = [];

  function flushDialogue() {
    if (pendingDialogueLines.length > 0 && currentSpeaker) {
      const fullDialogueText = pendingDialogueLines.join(' ').trim();
      const nuance = analyzeLineNuance({
        text: fullDialogueText,
        parenthetical: currentParenthetical,
        speakerType: 'CHARACTER'
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
        nuance
      };

      elements.push(element);

      // Track character stats
      if (!characterSet.has(currentSpeaker)) {
        characterSet.set(currentSpeaker, { name: currentSpeaker, count: 0, sampleLine: fullDialogueText });
      }
      characterSet.get(currentSpeaker).count++;

      pendingDialogueLines = [];
      currentParenthetical = '';
    }
  }

  for (let idx = startLine; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trim();

    // Skip empty lines
    if (!trimmed) {
      flushDialogue();
      inDialogueBlock = false;
      continue;
    }

    // Ignore title block tags if still present
    if (/^(Title|Author|Authors|Credit|Source|Draft date|Contact|Copyright):/i.test(trimmed)) {
      continue;
    }

    // Ignore fountain comments [[ ... ]]
    if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) continue;

    // 1. Scene Headings (e.g. EXT. OMNICORP SPIRE - 80TH FLOOR LEDGE - NIGHT)
    if (SCENE_REGEX.test(trimmed) || (trimmed.startsWith('.') && trimmed.length > 1 && !trimmed.startsWith('..'))) {
      flushDialogue();
      inDialogueBlock = false;
      currentSpeaker = null;

      currentSceneNumber++;
      currentSceneTitle = trimmed.replace(/^\./, '').trim();
      sceneList.push({ number: currentSceneNumber, title: currentSceneTitle, lineIndex });

      const nuance = analyzeLineNuance({
        text: currentSceneTitle,
        speakerType: 'ACTION'
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
        nuance
      });
      continue;
    }

    // 2. Transitions (e.g. CUT TO:)
    if (TRANSITION_REGEX.test(trimmed)) {
      flushDialogue();
      inDialogueBlock = false;
      currentSpeaker = null;

      const nuance = analyzeLineNuance({
        text: trimmed,
        speakerType: 'ACTION'
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
        nuance
      });
      continue;
    }

    // 3. Parentheticals (e.g. (whispering))
    const parenMatch = trimmed.match(PARENTHETICAL_REGEX);
    if (parenMatch && (inDialogueBlock || currentSpeaker)) {
      if (pendingDialogueLines.length > 0) {
        flushDialogue();
        inDialogueBlock = true;
      }
      currentParenthetical = parenMatch[1];
      continue;
    }

    // 4. Character Cue (e.g. SARAH (O.S.))
    // Standard screenplay rules: Uppercase name, preceded by empty line, not a scene heading or transition
    const charMatch = trimmed.match(CHARACTER_REGEX);
    const isLikelyCharacter = (
      charMatch &&
      !inDialogueBlock &&
      trimmed.length < 38 &&
      trimmed === trimmed.toUpperCase() &&
      !trimmed.includes('!') &&
      !trimmed.includes('?') &&
      !SCENE_REGEX.test(trimmed) &&
      !TRANSITION_REGEX.test(trimmed)
    );

    if (isLikelyCharacter) {
      flushDialogue();
      inDialogueBlock = true;
      currentSpeakerOriginal = trimmed;
      // Strip extensions like (V.O.), (O.S.), (CONT'D), (INTO PHONE)
      currentSpeaker = charMatch[1].replace(/\s*\([^)]*\)\s*/g, '').trim();
      currentParenthetical = '';
      continue;
    }

    // 5. Dialogue vs Action
    if (inDialogueBlock && currentSpeaker) {
      pendingDialogueLines.push(trimmed);
    } else {
      // Action / Description block (read by Narrator)
      flushDialogue();
      currentSpeaker = null;

      const nuance = analyzeLineNuance({
        text: trimmed,
        speakerType: 'ACTION'
      });

      elements.push({
        id: `line-${lineIndex++}`,
        type: 'ACTION',
        sceneNumber: currentSceneNumber || 1,
        sceneTitle: currentSceneTitle,
        character: 'NARRATOR',
        characterOriginal: 'NARRATOR',
        text: trimmed,
        parenthetical: '',
        nuance
      });
    }
  }

  flushDialogue();

  // Always ensure Narrator is in character list
  const characters = Array.from(characterSet.values()).map(c => ({
    name: c.name,
    lineCount: c.count,
    sampleLine: c.sampleLine
  }));

  // Sort characters by line count descending
  characters.sort((a, b) => b.lineCount - a.lineCount);

  return {
    title: scriptTitle,
    elements,
    characters,
    scenes: sceneList,
    totalLines: elements.length
  };
}

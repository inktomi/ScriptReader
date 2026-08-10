import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { analyzeLineNuance } from './emotion-analyzer.js';

// Configure worker for Vite client
if (typeof window !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
}

/**
 * Extracts and parses a Screenplay PDF file into structured screenplay elements
 */
export async function parsePdfScreenplay(fileOrBuffer, onProgress = () => {}) {
  let arrayBuffer;
  let fileName = 'Screenplay';

  if (fileOrBuffer instanceof File) {
    fileName = fileOrBuffer.name.replace(/\.[^/.]+$/, '');
    arrayBuffer = await fileOrBuffer.arrayBuffer();
  } else if (fileOrBuffer instanceof ArrayBuffer) {
    arrayBuffer = fileOrBuffer;
  } else {
    throw new Error('Invalid PDF data provided: expected File or ArrayBuffer.');
  }

  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;

  const rawLines = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    onProgress({ page: pageNum, totalPages: numPages, percent: Math.round((pageNum / numPages) * 100) });
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });

    // Group items by Y coordinate
    const items = textContent.items.filter(item => item.str && item.str.trim().length > 0);
    
    // Sort items by Y descending (top of page to bottom), then by X ascending
    items.sort((a, b) => {
      const yA = a.transform[5];
      const yB = b.transform[5];
      if (Math.abs(yA - yB) < 3.5) {
        return a.transform[4] - b.transform[4];
      }
      return yB - yA;
    });

    const pageLines = [];
    let currentLine = null;

    for (const item of items) {
      const x = item.transform[4];
      const y = item.transform[5];
      const str = item.str;

      if (!currentLine || Math.abs(currentLine.y - y) >= 3.5) {
        if (currentLine) {
          pageLines.push(currentLine);
        }
        currentLine = {
          y,
          minX: x,
          maxX: x + (item.width || 0),
          text: str,
          page: pageNum,
          pageWidth: viewport.width,
          pageHeight: viewport.height
        };
      } else {
        // Same vertical line: append with spacing if there is a gap
        const prevEndX = currentLine.maxX;
        const gap = x - prevEndX;
        if (gap > 4) {
          currentLine.text += ' ' + str;
        } else {
          currentLine.text += str;
        }
        currentLine.maxX = Math.max(currentLine.maxX, x + (item.width || 0));
      }
    }
    if (currentLine) {
      pageLines.push(currentLine);
    }

    // Filter out page numbers at header / footer
    const cleanedPageLines = pageLines.filter(line => {
      const t = line.text.trim();
      // Skip lone page numbers like "1.", "12", "PAGE 5"
      if (/^(\d+\.?|PAGE\s+\d+|[A-Z\s]+-\s+\d+\.?)$/i.test(t)) return false;
      return true;
    });

    rawLines.push(...cleanedPageLines);
  }

  // Now process lines with layout geometry and screenplay conventions
  return processExtractedLines(rawLines, fileName);
}

/**
 * Converts extracted raw PDF lines with X coordinates into structured screenplay elements
 */
function processExtractedLines(lines, scriptTitle) {
  const elements = [];
  const characterSet = new Map();
  const sceneList = [];

  let currentSceneNumber = 0;
  let currentSceneTitle = 'Scene 1';
  let currentSpeaker = null;
  let currentSpeakerOriginal = null;
  let currentParenthetical = '';
  let lineIndex = 0;

  const SCENE_REGEX = /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.|EST\.|INT\s|EXT\s|SCENE\s+\d+|PROLOGUE|EPILOGUE)(\s+|$)/i;
  const TRANSITION_REGEX = /^(CUT TO:|FADE IN:|FADE OUT\.|FADE TO BLACK\.|DISSOLVE TO:|SMASH CUT TO:|MATCH CUT TO:|JUMP CUT TO:|>.*<)$/i;
  const PARENTHETICAL_REGEX = /^\s*\((.+)\)\s*$/;

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

      elements.push({
        id: `line-${lineIndex++}`,
        type: 'DIALOGUE',
        sceneNumber: currentSceneNumber,
        sceneTitle: currentSceneTitle,
        character: currentSpeaker,
        characterOriginal: currentSpeakerOriginal || currentSpeaker,
        text: fullDialogueText,
        parenthetical: currentParenthetical,
        nuance
      });

      if (!characterSet.has(currentSpeaker)) {
        characterSet.set(currentSpeaker, { name: currentSpeaker, count: 0, sampleLine: fullDialogueText });
      }
      characterSet.get(currentSpeaker).count++;

      pendingDialogueLines = [];
      currentParenthetical = '';
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const item = lines[i];
    const text = item.text.trim();
    if (!text) {
      flushDialogue();
      inDialogueBlock = false;
      continue;
    }

    const normalizedXRatio = item.minX / (item.pageWidth || 612);

    // 1. Scene Heading (Left aligned, INT./EXT.)
    if (SCENE_REGEX.test(text)) {
      flushDialogue();
      inDialogueBlock = false;
      currentSpeaker = null;

      currentSceneNumber++;
      currentSceneTitle = text;
      sceneList.push({ number: currentSceneNumber, title: currentSceneTitle, lineIndex });

      const nuance = analyzeLineNuance({ text, speakerType: 'ACTION' });
      elements.push({
        id: `line-${lineIndex++}`,
        type: 'SCENE_HEADING',
        sceneNumber: currentSceneNumber,
        sceneTitle: currentSceneTitle,
        character: 'NARRATOR',
        characterOriginal: 'NARRATOR (SCENE)',
        text,
        parenthetical: '',
        nuance
      });
      continue;
    }

    // 2. Transitions (e.g. CUT TO:, right-aligned or regex)
    if (TRANSITION_REGEX.test(text) || (normalizedXRatio > 0.65 && text.endsWith(':'))) {
      flushDialogue();
      inDialogueBlock = false;
      currentSpeaker = null;

      const nuance = analyzeLineNuance({ text, speakerType: 'ACTION' });
      elements.push({
        id: `line-${lineIndex++}`,
        type: 'TRANSITION',
        sceneNumber: currentSceneNumber,
        sceneTitle: currentSceneTitle,
        character: 'NARRATOR',
        characterOriginal: 'NARRATOR',
        text,
        parenthetical: '',
        nuance
      });
      continue;
    }

    // 3. Parentheticals: (whispering) or (beat)
    const parenMatch = text.match(PARENTHETICAL_REGEX);
    if (parenMatch && (inDialogueBlock || currentSpeaker || (normalizedXRatio >= 0.28 && normalizedXRatio <= 0.55))) {
      currentParenthetical = parenMatch[1];
      continue;
    }

    // 4. Character Cue Detection:
    // Character cues in standard screenplays are indented ~35-50% from left margin, all uppercase, short
    const isIndentedCharacter = (
      normalizedXRatio >= 0.30 &&
      normalizedXRatio <= 0.58 &&
      text.length < 40 &&
      text === text.toUpperCase() &&
      !text.includes('!') &&
      !text.includes('?') &&
      !SCENE_REGEX.test(text)
    );

    const isExplicitCharacter = (
      !inDialogueBlock &&
      text.length < 35 &&
      text === text.toUpperCase() &&
      !text.includes('.') &&
      !text.includes('!') &&
      !text.includes('?') &&
      !SCENE_REGEX.test(text)
    );

    if (isIndentedCharacter || isExplicitCharacter) {
      flushDialogue();
      inDialogueBlock = true;
      currentSpeakerOriginal = text;
      // Clean extensions (V.O.), (O.S.), (CONT'D)
      currentSpeaker = text.replace(/\s*\([^)]*\)\s*/g, '').trim();
      currentParenthetical = '';
      continue;
    }

    // 5. Dialogue block continuation
    if (inDialogueBlock && currentSpeaker) {
      pendingDialogueLines.push(text);
    } else {
      // Action / Description block
      flushDialogue();
      currentSpeaker = null;

      const nuance = analyzeLineNuance({ text, speakerType: 'ACTION' });
      elements.push({
        id: `line-${lineIndex++}`,
        type: 'ACTION',
        sceneNumber: currentSceneNumber,
        sceneTitle: currentSceneTitle,
        character: 'NARRATOR',
        characterOriginal: 'NARRATOR',
        text,
        parenthetical: '',
        nuance
      });
    }
  }

  flushDialogue();

  const characters = Array.from(characterSet.values()).map(c => ({
    name: c.name,
    lineCount: c.count,
    sampleLine: c.sampleLine
  }));
  characters.sort((a, b) => b.lineCount - a.lineCount);

  return {
    title: scriptTitle || 'Exported Screenplay',
    elements,
    characters,
    scenes: sceneList,
    totalLines: elements.length
  };
}

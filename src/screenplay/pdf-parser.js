import * as pdfjsLib from 'pdfjs-dist';
import { analyzeLineNuance } from './emotion-analyzer.js';
import { annotateScriptFlow } from './overlap-pacing.js';
import {
  isPdfDialogueContinuation,
  shouldSplitPdfDialogueAtParenthetical
} from './pdf-layout.js';
import { attachCharacterIntroductions } from './character-introductions.js';

const pdfWorker = new URL(
  '../../node_modules/pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href;

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
  let pdfDoc = null;
  try {
    pdfDoc = await loadingTask.promise;
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
        const columnGap = Math.max(36, viewport.width * 0.06);
        if (gap > columnGap) {
          // Side-by-side dual dialogue occupies one PDF row but two screenplay
          // columns. Preserve those as separate geometric lines; concatenating
          // them destroys both speaker cues before parsing even begins.
          pageLines.push(currentLine);
          currentLine = {
            y,
            minX: x,
            maxX: x + (item.width || 0),
            text: str,
            page: pageNum,
            pageWidth: viewport.width,
            pageHeight: viewport.height
          };
          continue;
        }
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
  } finally {
    if (pdfDoc) {
      await pdfDoc.destroy();
    } else {
      await loadingTask.destroy();
    }
  }
}

function looksLikePdfCue(line) {
  if (!line) return false;
  const text = (line.text || '').trim();
  const ratio = line.minX / (line.pageWidth || 612);
  return ratio >= 0.22 && ratio <= 0.78 && text.length < 40
    && text === text.toUpperCase() && !/[.!?]$/.test(text);
}

/**
 * Turn row-major PDF extraction of dual dialogue into two contiguous cue blocks.
 * The right cue is tagged so the parser can restore the simultaneous relation.
 */
export function reorderPdfDualDialogue(lines) {
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const leftCue = lines[i];
    const rightCue = lines[i + 1];
    const sameRow = rightCue && leftCue.page === rightCue.page
      && Math.abs(leftCue.y - rightCue.y) < 3.5;
    const pageWidth = leftCue.pageWidth || 612;
    const separated = rightCue && leftCue.maxX < pageWidth * 0.55
      && rightCue.minX > pageWidth * 0.50;

    if (!sameRow || !separated || !looksLikePdfCue(leftCue) || !looksLikePdfCue(rightCue)) {
      output.push(leftCue);
      i++;
      continue;
    }

    const midpoint = (leftCue.maxX + rightCue.minX) / 2;
    const leftLines = [];
    const rightLines = [];
    let j = i + 2;
    let previousY = leftCue.y;

    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.page !== leftCue.page) break;
      const next = lines[j + 1];
      if (next && line.page === next.page && Math.abs(line.y - next.y) < 3.5
          && line.maxX < pageWidth * 0.55 && next.minX > pageWidth * 0.50
          && looksLikePdfCue(line) && looksLikePdfCue(next)) {
        break;
      }

      const ratio = line.minX / pageWidth;
      const verticalGap = Math.abs(previousY - line.y);
      if (ratio < 0.18 || ratio > 0.84 || verticalGap > 32) break;

      (line.minX < midpoint ? leftLines : rightLines).push(line);
      previousY = line.y;
    }

    // A cue pair without content is more likely unrelated header text.
    if (leftLines.length === 0 || rightLines.length === 0) {
      output.push(leftCue);
      i++;
      continue;
    }

    output.push(leftCue, ...leftLines, { ...rightCue, dualWithPrevious: true }, ...rightLines);
    i = j;
  }

  return output;
}

/**
 * Converts extracted raw PDF lines with X coordinates into structured screenplay elements
 */
export function processExtractedLines(lines, scriptTitle) {
  lines = reorderPdfDualDialogue(lines);
  const elements = [];
  const characterSet = new Map();
  const sceneList = [];

  let currentSceneNumber = 0;
  let currentSceneTitle = 'Scene 1';
  let currentSpeaker = null;
  let currentSpeakerOriginal = null;
  let currentParenthetical = '';
  let lineIndex = 0;
  let pendingDual = false;

  const SCENE_REGEX = /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.|EST\.|INT\s|EXT\s|SCENE\s+\d+|PROLOGUE|EPILOGUE)(\s+|$)/i;
  const TRANSITION_REGEX = /^(CUT TO:|FADE IN:|FADE OUT\.|FADE TO BLACK\.|DISSOLVE TO:|SMASH CUT TO:|MATCH CUT TO:|JUMP CUT TO:|>.*<)$/i;
  const PARENTHETICAL_REGEX = /^\s*\((.+)\)\s*$/;

  let inDialogueBlock = false;
  let pendingDialogueLines = [];

  function flushDialogue() {
    if (pendingDialogueLines.length > 0 && currentSpeaker) {
      const fullDialogueText = pendingDialogueLines.join(' ').trim();
      const extensionMatch = (currentSpeakerOriginal || '').match(/\([^)]*\)/g);
      const nuance = analyzeLineNuance({
        text: fullDialogueText,
        parenthetical: currentParenthetical,
        speakerType: 'CHARACTER',
        extension: extensionMatch ? extensionMatch.join(' ') : ''
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
        overlap: pendingDual
          ? { mode: 'simultaneous', withPrevious: true, offsetMs: null, source: 'pdf-columns' }
          : null,
        nuance
      });

      if (!characterSet.has(currentSpeaker)) {
        characterSet.set(currentSpeaker, { name: currentSpeaker, count: 0, sampleLine: fullDialogueText });
      }
      characterSet.get(currentSpeaker).count++;

      pendingDialogueLines = [];
      currentParenthetical = '';
      pendingDual = false;
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
    const previous = i > 0 ? lines[i - 1] : null;
    const verticalGap = previous && previous.page === item.page
      ? Math.abs(previous.y - item.y)
      : Infinity;
    const startsDialogueBlock = !inDialogueBlock || item.dualWithPrevious || verticalGap >= 16;

    let followerIndex = i + 1;
    while (followerIndex < lines.length && PARENTHETICAL_REGEX.test(lines[followerIndex].text.trim())) {
      followerIndex++;
    }
    const follower = lines[followerIndex];
    const followerRatio = follower ? follower.minX / (follower.pageWidth || 612) : -1;
    const hasDialogueFollower = !!follower && follower.page === item.page
      && follower.y <= item.y + 3.5
      && followerRatio >= 0.18 && followerRatio <= 0.72
      && !SCENE_REGEX.test(follower.text.trim())
      && !TRANSITION_REGEX.test(follower.text.trim());

    // 1. Scene Heading (Left aligned, INT./EXT.)
    if (SCENE_REGEX.test(text)) {
      flushDialogue();
      inDialogueBlock = false;
      currentSpeaker = null;

      currentSceneNumber++;
      currentSceneTitle = text;
      sceneList.push({ number: currentSceneNumber, title: currentSceneTitle, lineIndex });

      const nuance = analyzeLineNuance({ text, speakerType: 'SCENE_HEADING' });
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

      const nuance = analyzeLineNuance({ text, speakerType: 'TRANSITION' });
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
      if (shouldSplitPdfDialogueAtParenthetical(pendingDialogueLines)) {
        flushDialogue();
        inDialogueBlock = true;
      }
      currentParenthetical = parenMatch[1];
      continue;
    }

    // 4. Character Cue Detection:
    // Character cues in standard screenplays are indented ~35-50% from left margin, all uppercase, short
    const isIndentedCharacter = (
      startsDialogueBlock &&
      hasDialogueFollower &&
      normalizedXRatio >= 0.30 &&
      normalizedXRatio <= (item.dualWithPrevious ? 0.78 : 0.58) &&
      text.length < 40 &&
      text === text.toUpperCase() &&
      !text.includes('!') &&
      !text.includes('?') &&
      !SCENE_REGEX.test(text)
    );

    const isExplicitCharacter = (
      startsDialogueBlock &&
      hasDialogueFollower &&
      normalizedXRatio >= 0.24 &&
      normalizedXRatio <= (item.dualWithPrevious ? 0.78 : 0.62) &&
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
      pendingDual = !!item.dualWithPrevious;
      continue;
    }

    // 5. Dialogue block continuation
    if (isPdfDialogueContinuation(inDialogueBlock, currentSpeaker, normalizedXRatio)) {
      pendingDialogueLines.push(text);
    } else {
      // Action / Description block
      flushDialogue();
      currentSpeaker = null;
      inDialogueBlock = false;

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

  // A PDF carries no `^` and no notes, but a speaker cut off mid-sentence still
  // ends on a dash and a direction still reads "(interrupting)" — so the same
  // post-pass that serves Fountain gets an imported screenplay most of the way
  // there without this parser needing to know overlap exists. It also fills in
  // the pace/overlap fields, which is why they are absent above.
  // Character introductions matter more here than in Fountain: a PDF wraps its
  // action at the page margin, so the description is routinely split across two
  // extracted rows and only reassembles at the paragraph level.
  return attachCharacterIntroductions(annotateScriptFlow({
    title: scriptTitle || 'Exported Screenplay',
    elements,
    characters,
    scenes: sceneList,
    totalLines: elements.length
  }));
}

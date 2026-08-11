export function isPdfDialogueContinuation(inDialogueBlock, currentSpeaker, normalizedXRatio) {
  return Boolean(inDialogueBlock && currentSpeaker && normalizedXRatio >= 0.18);
}

export function shouldSplitPdfDialogueAtParenthetical(pendingDialogueLines) {
  return pendingDialogueLines.length > 0;
}

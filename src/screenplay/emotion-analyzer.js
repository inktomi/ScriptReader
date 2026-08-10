/**
 * Emotion & Nuance Analyzer for Screenplays
 * Parses parentheticals, dialogue sentiment, punctuation dynamics,
 * and converts raw screenplay formatting into natural studio-grade human speech.
 */

export const EMOTIONS = {
  COUGHING: {
    key: 'coughing',
    label: 'Gruff / Coughing',
    icon: '😷',
    pitchMod: 0.94,
    rateMod: 0.96,
    gainMod: 1.05,
    cueDelayMs: 280,
    badgeColor: '#D97706',
    description: 'Raspy, gruff delivery with vocal weight'
  },
  GASPING: {
    key: 'gasping',
    label: 'Gasping / Breathless',
    icon: '😮',
    pitchMod: 1.04,
    rateMod: 1.04,
    gainMod: 1.05,
    cueDelayMs: 260,
    badgeColor: '#A855F7',
    description: 'Sharp intake of breath with urgent delivery'
  },
  SIGHING: {
    key: 'sighing',
    label: 'Sighing / Heavy Heart',
    icon: '😮‍💨',
    pitchMod: 0.96,
    rateMod: 0.95,
    gainMod: 0.92,
    cueDelayMs: 300,
    badgeColor: '#64748B',
    description: 'Weary vocal sigh leading into dialogue'
  },
  CHUCKLING: {
    key: 'chuckling',
    label: 'Chuckling / Amused',
    icon: '😄',
    pitchMod: 1.02,
    rateMod: 1.02,
    gainMod: 1.02,
    cueDelayMs: 260,
    badgeColor: '#10B981',
    description: 'Lighthearted chuckle followed by dialogue'
  },
  COMMS: {
    key: 'comms',
    label: 'Radio Comms / Mic',
    icon: '📻',
    pitchMod: 0.99,
    rateMod: 1.01,
    gainMod: 1.0,
    cueDelayMs: 240,
    badgeColor: '#06B6D4',
    description: 'Tactical comms delivery'
  },
  WHISPER: {
    key: 'whisper',
    label: 'Whispering',
    icon: '🤫',
    pitchMod: 0.96,
    rateMod: 0.96,
    gainMod: 0.85,
    cueDelayMs: 260,
    badgeColor: '#06B6D4',
    description: 'Soft, intimate breathy delivery'
  },
  SHOUT: {
    key: 'shout',
    label: 'Shouting / Urgent',
    icon: '📢',
    pitchMod: 1.05,
    rateMod: 1.04,
    gainMod: 1.15,
    cueDelayMs: 220,
    badgeColor: '#EF4444',
    description: 'High energy, intense volume and crisp projection'
  },
  ANGRY: {
    key: 'angry',
    label: 'Angry / Intense',
    icon: '⚡',
    pitchMod: 1.03,
    rateMod: 1.03,
    gainMod: 1.10,
    cueDelayMs: 240,
    badgeColor: '#F43F5E',
    description: 'Sharp, focused consonants and resolute tempo'
  },
  SAD: {
    key: 'sad',
    label: 'Sad / Melancholy',
    icon: '💧',
    pitchMod: 0.96,
    rateMod: 0.94,
    gainMod: 0.90,
    cueDelayMs: 320,
    badgeColor: '#60A5FA',
    description: 'Gentle cadence with emotional warmth'
  },
  FEAR: {
    key: 'fear',
    label: 'Terrified / Panicked',
    icon: '😨',
    pitchMod: 1.04,
    rateMod: 1.05,
    gainMod: 1.05,
    cueDelayMs: 240,
    badgeColor: '#A855F7',
    description: 'Rapid, breathy, urgent pacing'
  },
  EXCITED: {
    key: 'excited',
    label: 'Excited / Euphoric',
    icon: '✨',
    pitchMod: 1.04,
    rateMod: 1.03,
    gainMod: 1.05,
    cueDelayMs: 230,
    badgeColor: '#F59E0B',
    description: 'Bright, bouncy, upbeat enthusiasm'
  },
  SARCASTIC: {
    key: 'sarcastic',
    label: 'Sarcastic / Dry',
    icon: '😏',
    pitchMod: 0.98,
    rateMod: 0.97,
    gainMod: 0.98,
    cueDelayMs: 280,
    badgeColor: '#10B981',
    description: 'Deadpan delivery with deliberate pauses'
  },
  TENDER: {
    key: 'tender',
    label: 'Tender / Loving',
    icon: '❤️',
    pitchMod: 0.98,
    rateMod: 0.96,
    gainMod: 0.92,
    cueDelayMs: 280,
    badgeColor: '#FB7185',
    description: 'Warm, soft, gentle emotional connection'
  },
  COMMANDING: {
    key: 'commanding',
    label: 'Authoritative / Stern',
    icon: '🛡️',
    pitchMod: 0.97,
    rateMod: 0.98,
    gainMod: 1.05,
    cueDelayMs: 260,
    badgeColor: '#8B5CF6',
    description: 'Deep, steady, resonant authority'
  },
  HESITANT: {
    key: 'hesitant',
    label: 'Hesitant / Reflective',
    icon: '💭',
    pitchMod: 1.01,
    rateMod: 0.95,
    gainMod: 0.92,
    cueDelayMs: 340,
    badgeColor: '#94A3B8',
    description: 'Uncertain pauses and measured cadence'
  },
  BEAT: {
    key: 'beat',
    label: 'Dramatic Beat / Pause',
    icon: '⏱️',
    pitchMod: 1.0,
    rateMod: 1.0,
    gainMod: 1.0,
    cueDelayMs: 800,
    badgeColor: '#64748B',
    description: 'Deliberate dramatic silence for tension'
  },
  NEUTRAL: {
    key: 'neutral',
    label: 'Natural Dialogue',
    icon: '💬',
    pitchMod: 1.0,
    rateMod: 1.0,
    gainMod: 1.0,
    cueDelayMs: 250,
    badgeColor: '#94A3B8',
    description: 'Balanced natural conversational cadence'
  }
};

/**
 * Common acronyms and abbreviations that should remain capitalized / pronounced as acronyms
 */
const ACRONYMS = new Set([
  'FBI', 'CIA', 'EMP', 'AI', 'DNA', 'SWAT', 'NASA', 'CCTV', 'VIP', 'POV',
  'HQ', 'PIN', 'USB', 'GPS', 'UAV', 'O.S.', 'V.O.', 'I/E', 'ID', 'OK',
  'TV', 'PC', 'VR', 'AR', 'CPU', 'GPU', 'UN', 'US', 'UK', 'EU', 'NYPD',
  'LAPD', 'EMS', 'ATF', 'NSA', 'MIA', 'KIA', 'ETA', 'SOS'
]);

/**
 * Ordinal mappings
 */
const ORDINALS = {
  '1ST': 'first',
  '2ND': 'second',
  '3RD': 'third',
  '4TH': 'fourth',
  '5TH': 'fifth',
  '6TH': 'sixth',
  '7TH': 'seventh',
  '8TH': 'eighth',
  '9TH': 'ninth',
  '10TH': 'tenth',
  '20TH': 'twentieth',
  '30TH': 'thirtieth',
  '40TH': 'fortieth',
  '50TH': 'fiftieth',
  '60TH': 'sixtieth',
  '70TH': 'seventieth',
  '80TH': 'eightieth',
  '90TH': 'ninetieth',
  '100TH': 'hundredth'
};

/**
 * Keyword matchers for parentheticals and text cues
 */
const EMOTION_PATTERNS = [
  { emotion: EMOTIONS.COUGHING, regex: /\b(cough|coughing|coughs|gruff|clears throat|clearing throat|raspy|wheezing)\b/i },
  { emotion: EMOTIONS.GASPING, regex: /\b(gasp|gasping|gasps|breathless|out of breath)\b/i },
  { emotion: EMOTIONS.SIGHING, regex: /\b(sigh|sighs|sighing|heavy sigh)\b/i },
  { emotion: EMOTIONS.CHUCKLING, regex: /\b(chuckle|chuckles|chuckling|grins|smiles|smirks)\b/i },
  { emotion: EMOTIONS.COMMS, regex: /\b(over comms|into collar mic|into phone|on radio|through speaker|over radio|comms)\b/i },
  { emotion: EMOTIONS.WHISPER, regex: /\b(whisper|whispering|whispered|hushed|softly|under (his|her|their) breath|quietly|muffled|secretive)\b/i },
  { emotion: EMOTIONS.SHOUT, regex: /\b(shout|shouting|shouted|scream|screaming|screamed|yell|yelling|bellows|roars|exploding|howling)\b/i },
  { emotion: EMOTIONS.ANGRY, regex: /\b(angry|angrily|furious|furiously|teeth|growls|snarls|livid|hostile|irritated|fuming|snaps|glaring|sternly)\b/i },
  { emotion: EMOTIONS.SAD, regex: /\b(sad|sadly|crying|cries|sobbing|sobs|tearful|tears|weeping|mournful|heartbroken|choked up|breaking down)\b/i },
  { emotion: EMOTIONS.FEAR, regex: /\b(terrified|terror|panicked|panic|fearful|trembling|quivering|horrified|dread)\b/i },
  { emotion: EMOTIONS.EXCITED, regex: /\b(excited|excitedly|thrilled|laughing|laughs|giggles|cheerful|joyful|beaming|jubilant|elated)\b/i },
  { emotion: EMOTIONS.SARCASTIC, regex: /\b(sarcastic|sarcastically|dryly|deadpan|mocking|ironic|rolling eyes|scoffs)\b/i },
  { emotion: EMOTIONS.TENDER, regex: /\b(tender|tenderly|lovingly|affectionate|gentle|warmly|embracing|caressing|softly smiles)\b/i },
  { emotion: EMOTIONS.COMMANDING, regex: /\b(commanding|orders|authoritative|firmly|strictly|demanding|decisive|regal)\b/i },
  { emotion: EMOTIONS.HESITANT, regex: /\b(hesitant|hesitates|hesitantly|stuttering|stammers|unsure|nervous|fumbling|stammer)\b/i },
  { emotion: EMOTIONS.BEAT, regex: /\b(beat|pause|silence|long pause|a moment|after a beat|taking a breath)\b/i }
];

/**
 * Normalizes all-caps words in screenplay text into human sentence casing,
 * while preserving acronyms (EMP, AI, FBI) and compound hyphens.
 */
function normalizeWordCasing(text) {
  if (!text) return '';

  return text.replace(/\b[A-Z0-9'-]+\b/g, (token) => {
    if (ACRONYMS.has(token)) {
      return token;
    }

    if (ORDINALS[token]) {
      return ORDINALS[token];
    }

    if (token === 'A' || token === 'I') {
      return token;
    }

    if (token === token.toUpperCase() && /^[A-Z]/.test(token)) {
      if (/^\d+S$/.test(token)) {
        return token.toLowerCase();
      }
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    }

    return token;
  });
}

/**
 * Formats scene headings into natural cinematic spoken sentences for the narrator.
 */
function formatSceneHeading(headingText) {
  if (!headingText) return '';

  let cleaned = headingText.trim();

  let prefix = '';
  if (/^INT\.\/EXT\.\s*/i.test(cleaned)) {
    prefix = 'Interior and Exterior: ';
    cleaned = cleaned.replace(/^INT\.\/EXT\.\s*/i, '');
  } else if (/^EXT\.\/INT\.\s*/i.test(cleaned)) {
    prefix = 'Exterior and Interior: ';
    cleaned = cleaned.replace(/^EXT\.\/INT\.\s*/i, '');
  } else if (/^I\/E\.\s*/i.test(cleaned)) {
    prefix = 'Interior, Exterior: ';
    cleaned = cleaned.replace(/^I\/E\.\s*/i, '');
  } else if (/^INT\.\s*/i.test(cleaned)) {
    prefix = 'Interior: ';
    cleaned = cleaned.replace(/^INT\.\s*/i, '');
  } else if (/^EXT\.\s*/i.test(cleaned)) {
    prefix = 'Exterior: ';
    cleaned = cleaned.replace(/^EXT\.\s*/i, '');
  } else if (/^EST\.\s*/i.test(cleaned)) {
    prefix = 'Establishing: ';
    cleaned = cleaned.replace(/^EST\.\s*/i, '');
  }

  const parts = cleaned.split(/\s+-\s+|\s+--\s+/);
  const formattedParts = parts.map((part, idx) => {
    let p = part.trim();
    if (idx === 0) {
      p = normalizeWordCasing(p);
    } else {
      p = normalizeWordCasing(p);
      p = p.replace(/\b(Night|Day|Dawn|Dusk|Evening|Continuous|Same Time|Moments Later|Later|Floor|Ledge)\b/g, m => m.toLowerCase());
    }
    return p;
  });

  let result = prefix + formattedParts.join(', ');
  if (!result.endsWith('.')) result += '.';
  return result;
}

/**
 * Transforms raw screenplay shorthand into natural, fluid spoken prose for TTS engines.
 */
export function cleanSpeechForSynthesis(text, speakerType = 'CHARACTER') {
  if (!text) return '';

  let spoken = text;

  // 1. Strip parentheticals and stage directions from spoken dialogue
  spoken = spoken.replace(/\s*\([^)]*\)\s*/g, ' ');

  // 2. Special Scene Heading formatting
  if (speakerType === 'SCENE_HEADING') {
    return formatSceneHeading(spoken);
  }

  // 3. Transitions
  if (speakerType === 'TRANSITION') {
    spoken = spoken.replace(/^>|<$/g, '').trim();
    spoken = normalizeWordCasing(spoken);
    if (!spoken.endsWith('.')) spoken += '.';
    return spoken;
  }

  // 4. Action lines vs Dialogue Casing Normalization
  if (speakerType === 'ACTION') {
    spoken = normalizeWordCasing(spoken);
  } else {
    const words = spoken.split(/\s+/);
    const isAllUpper = words.length > 2 && words.every(w => w === w.toUpperCase() && !/^\d+$/.test(w));
    if (isAllUpper) {
      spoken = normalizeWordCasing(spoken);
    }
  }

  // 5. Screenplay abbreviations & honorifics
  spoken = spoken
    .replace(/\bDr\.\s+/gi, 'Doctor ')
    .replace(/\bMr\.\s+/gi, 'Mister ')
    .replace(/\bMrs\.\s+/gi, 'Missus ')
    .replace(/\bMs\.\s+/gi, 'Mizz ')
    .replace(/\bLt\.\s+/gi, 'Lieutenant ')
    .replace(/\bCapt\.\s+/gi, 'Captain ')
    .replace(/\bCmdr\.\s+/gi, 'Commander ')
    .replace(/\bSgt\.\s+/gi, 'Sergeant ')
    .replace(/\bDet\.\s+/gi, 'Detective ')
    .replace(/\bProf\.\s+/gi, 'Professor ')
    .replace(/\bGen\.\s+/gi, 'General ')
    .replace(/\bGov\.\s+/gi, 'Governor ')
    .replace(/\bSen\.\s+/gi, 'Senator ')
    .replace(/\bRev\.\s+/gi, 'Reverend ')
    .replace(/\bSt\.\s+/gi, 'Saint ');

  // 6. Common ordinals and number expressions
  spoken = spoken
    .replace(/\b80th\b/gi, 'eightieth')
    .replace(/\b1st\b/gi, 'first')
    .replace(/\b2nd\b/gi, 'second')
    .replace(/\b3rd\b/gi, 'third')
    .replace(/\b4th\b/gi, 'fourth')
    .replace(/\b5th\b/gi, 'fifth')
    .replace(/\b10th\b/gi, 'tenth')
    .replace(/\b20th\b/gi, 'twentieth')
    .replace(/\b(\d+)\s*%/g, '$1 percent');

  // 7. Normalize punctuation & breathing dashes
  spoken = spoken
    .replace(/\s*--\s*/g, ', ')
    .replace(/\s+—\s+/g, ', ')
    .replace(/\s*;\s*/g, ', ')
    .replace(/\s*\.\.\.\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

  return spoken;
}

/**
 * Analyzes dialogue text and parenthetical to compute full performance metadata
 */
export function analyzeLineNuance({ text, parenthetical = '', speakerType = 'CHARACTER' }) {
  let matchedEmotion = null;
  let isBeat = false;
  let detectedDirection = parenthetical.replace(/^\(|\)$/g, '').trim();

  // 1. Check explicit parenthetical direction first
  if (parenthetical) {
    const pClean = parenthetical.toLowerCase();
    
    for (const item of EMOTION_PATTERNS) {
      if (item.regex.test(pClean)) {
        matchedEmotion = item.emotion;
        if (item.emotion.key === 'beat') {
          isBeat = true;
        }
        break;
      }
    }
  }

  // 2. If no parenthetical emotion, analyze dialogue text
  if (!matchedEmotion && text) {
    const rawText = text.trim();

    if (speakerType === 'CHARACTER' || speakerType === 'DIALOGUE') {
      const words = rawText.split(/\s+/);
      const capsWords = words.filter(w => w.length > 2 && w === w.toUpperCase() && /^[A-Z!?,.]+$/.test(w) && !ACRONYMS.has(w.replace(/[!?,.]/g, '')));
      if ((capsWords.length >= 2 && rawText.includes('!')) || (words.length <= 3 && capsWords.length >= 1 && rawText.includes('!'))) {
        matchedEmotion = EMOTIONS.SHOUT;
      } else if (rawText.endsWith('!!!') || rawText.includes('!!')) {
        matchedEmotion = EMOTIONS.ANGRY;
      } else if (rawText.startsWith('...') || rawText.includes('...')) {
        matchedEmotion = EMOTIONS.HESITANT;
      }
    }

    if (!matchedEmotion && speakerType !== 'SCENE_HEADING') {
      for (const item of EMOTION_PATTERNS) {
        if (item.regex.test(rawText)) {
          matchedEmotion = item.emotion;
          break;
        }
      }
    }
  }

  const emotion = matchedEmotion || (speakerType === 'ACTION' ? EMOTIONS.COMMANDING : EMOTIONS.NEUTRAL);
  const cleanSpeech = cleanSpeechForSynthesis(text, speakerType);
  const isQuestion = cleanSpeech.endsWith('?');
  const isExclamation = cleanSpeech.endsWith('!');

  return {
    emotionKey: emotion.key,
    emotionLabel: emotion.label,
    emotionIcon: emotion.icon,
    badgeColor: emotion.badgeColor,
    directionText: detectedDirection,
    description: emotion.description,
    cleanSpeech: cleanSpeech || text,
    pitchMod: isQuestion ? emotion.pitchMod * 1.02 : (isExclamation ? emotion.pitchMod * 1.02 : emotion.pitchMod),
    rateMod: emotion.rateMod,
    gainMod: emotion.gainMod,
    cueDelayMs: isBeat ? 800 : emotion.cueDelayMs,
    isQuestion,
    isExclamation,
    isBeat
  };
}

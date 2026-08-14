/**
 * Emotion & Nuance Analyzer for Screenplays
 *
 * Turns a screenwriter's direction — "(authoritative, keeping composure)" — into
 * concrete delivery parameters, and rewrites screenplay shorthand into prose a
 * TTS engine can actually read aloud.
 *
 * Delivery parameters, and how each is realised downstream:
 *   speedMod    — scales Kokoro's `speed` (tempo, pitch-preserving)
 *   pitchMod    — playback-rate pitch shift, compensated in `speed` so tempo holds
 *   gainMod     — output level (the difference between a whisper and a shout)
 *   leadPauseMs — silence inserted *before* the line
 *   filter      — 'radio' for comms, 'distant' for off-screen, null for in-room
 *
 * The mods are intentionally wide enough to hear. A 2% pitch change is not a
 * performance; it is rounding error.
 */

const NO_FILTER = null;

export const EMOTIONS = {
  COUGHING: {
    key: 'coughing',
    label: 'Gruff / Coughing',
    icon: '😷',
    speedMod: 0.92,
    pitchMod: 0.93,
    gainMod: 1.02,
    leadPauseMs: 200,
    filter: NO_FILTER,
    badgeColor: '#D97706',
    description: 'Raspy, gruff delivery with vocal weight',
  },
  GASPING: {
    key: 'gasping',
    label: 'Gasping / Breathless',
    icon: '😮',
    speedMod: 1.14,
    pitchMod: 1.05,
    gainMod: 1.02,
    leadPauseMs: 90,
    filter: NO_FILTER,
    badgeColor: '#A855F7',
    description: 'Sharp intake of breath with urgent delivery',
  },
  SIGHING: {
    key: 'sighing',
    label: 'Sighing / Heavy Heart',
    icon: '😮‍💨',
    speedMod: 0.9,
    pitchMod: 0.96,
    gainMod: 0.85,
    leadPauseMs: 280,
    filter: NO_FILTER,
    badgeColor: '#64748B',
    description: 'Weary vocal sigh leading into dialogue',
  },
  CHUCKLING: {
    key: 'chuckling',
    label: 'Chuckling / Amused',
    icon: '😄',
    speedMod: 1.03,
    pitchMod: 1.04,
    gainMod: 1.02,
    leadPauseMs: 150,
    filter: NO_FILTER,
    badgeColor: '#10B981',
    description: 'Lighthearted chuckle followed by dialogue',
  },
  COMMS: {
    key: 'comms',
    label: 'Radio Comms / Mic',
    icon: '📻',
    speedMod: 1.02,
    pitchMod: 1.0,
    gainMod: 0.95,
    leadPauseMs: 130,
    filter: 'radio',
    badgeColor: '#06B6D4',
    description: 'Tactical comms delivery through a speaker',
  },
  SYNTHETIC: {
    key: 'synthetic',
    label: 'Synthetic / Artificial',
    icon: '🤖',
    speedMod: 0.97,
    pitchMod: 1.0,
    gainMod: 0.97,
    leadPauseMs: 150,
    filter: 'radio',
    badgeColor: '#22D3EE',
    description: 'Flat, evenly-metered artificial voice',
  },
  WHISPER: {
    key: 'whisper',
    label: 'Whispering',
    icon: '🤫',
    speedMod: 0.9,
    pitchMod: 0.97,
    gainMod: 0.55,
    leadPauseMs: 180,
    filter: NO_FILTER,
    badgeColor: '#06B6D4',
    description: 'Soft, intimate breathy delivery',
  },
  SHOUT: {
    key: 'shout',
    label: 'Shouting / Urgent',
    icon: '📢',
    speedMod: 1.1,
    pitchMod: 1.07,
    gainMod: 1.3,
    leadPauseMs: 60,
    filter: NO_FILTER,
    badgeColor: '#EF4444',
    description: 'High energy, intense volume and crisp projection',
  },
  ANGRY: {
    key: 'angry',
    label: 'Angry / Intense',
    icon: '⚡',
    speedMod: 1.06,
    pitchMod: 1.03,
    gainMod: 1.2,
    leadPauseMs: 90,
    filter: NO_FILTER,
    badgeColor: '#F43F5E',
    description: 'Sharp, focused consonants and resolute tempo',
  },
  SAD: {
    key: 'sad',
    label: 'Sad / Melancholy',
    icon: '💧',
    speedMod: 0.88,
    pitchMod: 0.96,
    gainMod: 0.82,
    leadPauseMs: 260,
    filter: NO_FILTER,
    badgeColor: '#60A5FA',
    description: 'Gentle cadence with emotional warmth',
  },
  FEAR: {
    key: 'fear',
    label: 'Terrified / Panicked',
    icon: '😨',
    speedMod: 1.12,
    pitchMod: 1.06,
    gainMod: 1.02,
    leadPauseMs: 80,
    filter: NO_FILTER,
    badgeColor: '#A855F7',
    description: 'Rapid, breathy, urgent pacing',
  },
  EXCITED: {
    key: 'excited',
    label: 'Excited / Euphoric',
    icon: '✨',
    speedMod: 1.1,
    pitchMod: 1.05,
    gainMod: 1.1,
    leadPauseMs: 70,
    filter: NO_FILTER,
    badgeColor: '#F59E0B',
    description: 'Bright, bouncy, upbeat enthusiasm',
  },
  SARCASTIC: {
    key: 'sarcastic',
    label: 'Sarcastic / Dry',
    icon: '😏',
    speedMod: 0.93,
    pitchMod: 0.98,
    gainMod: 0.95,
    leadPauseMs: 220,
    filter: NO_FILTER,
    badgeColor: '#10B981',
    description: 'Deadpan delivery with deliberate pauses',
  },
  TENDER: {
    key: 'tender',
    label: 'Tender / Loving',
    icon: '❤️',
    speedMod: 0.9,
    pitchMod: 0.99,
    gainMod: 0.85,
    leadPauseMs: 200,
    filter: NO_FILTER,
    badgeColor: '#FB7185',
    description: 'Warm, soft, gentle emotional connection',
  },
  COMMANDING: {
    key: 'commanding',
    label: 'Authoritative / Stern',
    icon: '🛡️',
    speedMod: 0.93,
    pitchMod: 0.94,
    gainMod: 1.12,
    leadPauseMs: 120,
    filter: NO_FILTER,
    badgeColor: '#8B5CF6',
    description: 'Deep, steady, resonant authority',
  },
  HESITANT: {
    key: 'hesitant',
    label: 'Hesitant / Reflective',
    icon: '💭',
    speedMod: 0.88,
    pitchMod: 1.0,
    gainMod: 0.88,
    leadPauseMs: 280,
    filter: NO_FILTER,
    badgeColor: '#94A3B8',
    description: 'Uncertain pauses and measured cadence',
  },
  BEAT: {
    key: 'beat',
    label: 'Dramatic Beat / Pause',
    icon: '⏱️',
    speedMod: 1.0,
    pitchMod: 1.0,
    gainMod: 1.0,
    leadPauseMs: 750,
    filter: NO_FILTER,
    badgeColor: '#64748B',
    description: 'Deliberate dramatic silence for tension',
  },
  NARRATION: {
    key: 'narration',
    label: 'Stage Direction',
    icon: '🎬',
    speedMod: 0.99,
    pitchMod: 1.0,
    gainMod: 0.9,
    leadPauseMs: 0,
    filter: NO_FILTER,
    badgeColor: '#F59E0B',
    description: 'Even, unhurried reading of action and description',
  },
  NEUTRAL: {
    key: 'neutral',
    label: 'Natural Dialogue',
    icon: '💬',
    speedMod: 1.0,
    pitchMod: 1.0,
    gainMod: 1.0,
    leadPauseMs: 0,
    filter: NO_FILTER,
    badgeColor: '#94A3B8',
    description: 'Balanced natural conversational cadence',
  },
};

/**
 * Common acronyms and abbreviations that should remain capitalized / pronounced as acronyms
 */
const ACRONYMS = new Set([
  'FBI',
  'CIA',
  'EMP',
  'AI',
  'DNA',
  'SWAT',
  'NASA',
  'CCTV',
  'VIP',
  'POV',
  'HQ',
  'PIN',
  'USB',
  'GPS',
  'UAV',
  'O.S.',
  'V.O.',
  'I/E',
  'ID',
  'OK',
  'TV',
  'PC',
  'VR',
  'AR',
  'CPU',
  'GPU',
  'UN',
  'US',
  'UK',
  'EU',
  'NYPD',
  'LAPD',
  'EMS',
  'ATF',
  'NSA',
  'MIA',
  'KIA',
  'ETA',
  'SOS',
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
  '100TH': 'hundredth',
};

/**
 * Keyword matchers for parentheticals and text cues.
 *
 * Order encodes specificity: the earliest match becomes the primary performance,
 * later matches layer in at reduced weight. BEAT is handled separately because
 * "(beat, whispering)" is a pause *and* a whisper, not a choice between them.
 */
const EMOTION_PATTERNS = [
  {
    emotion: EMOTIONS.WHISPER,
    regex:
      /\b(whisper|whispering|whispered|hushed|softly|under (his|her|their) breath|quietly|muffled|secretive|sotto)\b/i,
  },
  {
    emotion: EMOTIONS.SHOUT,
    regex:
      /\b(shout|shouting|shouted|scream|screaming|screamed|yell|yelling|bellow|bellows|bellowing|roar|roars|roaring|booming|exploding|howling|hysterical)\b/i,
  },
  {
    emotion: EMOTIONS.COMMS,
    regex:
      /\b(over comms|into collar mic|into (the )?phone|on (the )?radio|through (the )?speaker|over (the )?radio|over (the )?intercom|comms|walkie|headset|filtered)\b/i,
  },
  {
    emotion: EMOTIONS.SYNTHETIC,
    regex: /\b(synth|synthetic|synthesized|robotic|computerized|mechanical|artificial|automated|monotone)\b/i,
  },
  {
    emotion: EMOTIONS.COUGHING,
    regex: /\b(cough|coughing|coughs|gruff|clears throat|clearing throat|raspy|wheezing|hoarse)\b/i,
  },
  { emotion: EMOTIONS.GASPING, regex: /\b(gasp|gasping|gasps|breathless|out of breath|panting|winded)\b/i },
  { emotion: EMOTIONS.SIGHING, regex: /\b(sigh|sighs|sighing|heavy sigh|wearily|weary|exhausted|resigned)\b/i },
  {
    emotion: EMOTIONS.CHUCKLING,
    regex: /\b(chuckle|chuckles|chuckling|grin|grins|grinning|smiles|smirk|smirks|smirking|amused|wry)\b/i,
  },
  {
    emotion: EMOTIONS.FEAR,
    regex:
      /\b(terrified|terror|panicked|panic|panicking|fearful|trembling|quivering|horrified|dread|frantic|frantically)\b/i,
  },
  {
    emotion: EMOTIONS.ANGRY,
    regex:
      /\b(angry|angrily|furious|furiously|through (his|her|their|clenched) teeth|growls|growling|snarls|livid|hostile|irritated|fuming|snaps|snapping|glaring|sternly|seething|bitter)\b/i,
  },
  {
    emotion: EMOTIONS.SAD,
    regex:
      /\b(sad|sadly|crying|cries|sobbing|sobs|tearful|tears|weeping|mournful|heartbroken|choked up|breaking down|grief|grieving)\b/i,
  },
  {
    emotion: EMOTIONS.EXCITED,
    regex:
      /\b(excited|excitedly|thrilled|laughing|laughs|giggles|cheerful|joyful|beaming|jubilant|elated|eager|eagerly)\b/i,
  },
  {
    emotion: EMOTIONS.SARCASTIC,
    regex:
      /\b(sarcastic|sarcastically|dryly|dry|deadpan|mocking|mockingly|ironic|rolling eyes|scoffs|coldly amused|sardonic)\b/i,
  },
  {
    emotion: EMOTIONS.TENDER,
    regex:
      /\b(tender|tenderly|lovingly|affectionate|gentle|gently|warmly|gentler|softening|soothing|gently smiles|softly smiles)\b/i,
  },
  {
    emotion: EMOTIONS.COMMANDING,
    regex:
      /\b(commanding|command|orders|ordering|authoritative|authority|firmly|firm|strictly|demanding|decisive|regal|composure|composed|resolute|steady|measured|dignified|unwavering|coldly)\b/i,
  },
  {
    emotion: EMOTIONS.HESITANT,
    regex:
      /\b(hesitant|hesitates|hesitantly|stuttering|stammers|stammer|unsure|uncertain|nervous|nervously|fumbling|timid|apologetic|reluctant|realization|reflective|thoughtful)\b/i,
  },
];

const BEAT_REGEX = /\b(beat|pause|silence|long pause|a moment|after a beat|taking a breath)\b/i;

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
    let p = normalizeWordCasing(part.trim());
    if (idx > 0) {
      p = p.replace(/\b(Night|Day|Dawn|Dusk|Evening|Continuous|Same Time|Moments Later|Later|Floor|Ledge)\b/g, (m) =>
        m.toLowerCase(),
      );
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
export function cleanSpeechForSynthesis(text, speakerType = 'CHARACTER', { cutOff = false, pickUp = false } = {}) {
  if (!text) return '';

  let spoken = text;

  // 1. Strip parentheticals and stage directions from spoken dialogue
  spoken = spoken.replace(/\s*\([^)]*\)\s*/g, ' ');

  // 1b. Strip production notes. The parser drops notes that occupy a whole
  //     line, but one written mid-sentence reaches us intact, and the
  //     synthesiser will happily read the brackets out loud.
  spoken = spoken.replace(/\[\[[^\]]*\]\]/g, ' ');

  // 1c. A line that opens by cutting in starts with a dash. Removing it here
  //     keeps it from becoming a leading comma further down, which made the
  //     speaker begin on an odd little hitch.
  if (pickUp || /^\s*["'‘“([]*\s*(--+|—|–)/.test(spoken)) {
    spoken = spoken.replace(/^(\s*["'‘“([]*)\s*(--+|—|–)\s*/, '$1');
  }

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
    const isAllUpper = words.length > 2 && words.every((w) => w === w.toUpperCase() && !/^\d+$/.test(w));
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

  // 7. Normalize punctuation & breathing dashes.
  //    A trailing ellipsis becomes a full stop: it should trail off into the
  //    following pause, not leave the synthesiser hanging on a comma.
  //
  //    A line someone else talks over is the exception. Ending it on a full
  //    stop makes the speaker sound like they finished their thought and were
  //    then rudely followed; leaving it with no terminal punctuation at all is
  //    what makes the synthesiser hold the pitch up, so the line still sounds
  //    like it was going somewhere when it was taken away.
  spoken = spoken
    .replace(/\s*(\.\.\.|--+|—|–)\s*(["'’”»›)\]}]*)$/, (_, __, quotes) => (cutOff ? '' : '.') + quotes)
    .replace(/\s*--\s*/g, ', ')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*;\s*/g, ', ')
    .replace(/\s*\.\.\.\s*/g, ', ')
    .replace(/\s*,\s*,\s*/g, ', ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/,\s*(["'’”»›)\]}]*)$/, (_, quotes) => (cutOff ? '' : '.') + quotes)
    .replace(/\s+/g, ' ')
    .trim();

  // A line reduced to bare punctuation has nothing to say.
  if (!/[a-z0-9]/i.test(spoken)) return '';

  return spoken;
}

/**
 * How forcefully to apply a direction, 0..1, read off punctuation and emphasis caps.
 */
function measureIntensity(rawText) {
  if (!rawText) return 0.5;

  let intensity = 0.5;

  const bangs = (rawText.match(/!/g) || []).length;
  if (bangs >= 2) intensity += 0.35;
  else if (bangs === 1) intensity += 0.18;

  const words = rawText.split(/\s+/);
  const emphasisCaps = words.filter(
    (w) => w.length > 2 && w === w.toUpperCase() && /^[A-Z!?,.']+$/.test(w) && !ACRONYMS.has(w.replace(/[!?,.']/g, '')),
  );
  if (emphasisCaps.length >= 2) intensity += 0.25;
  else if (emphasisCaps.length === 1) intensity += 0.12;

  return Math.max(0, Math.min(1, intensity));
}

/** Scale a multiplier's deviation from neutral by how intense the line reads. */
function scaleMod(mod, intensity) {
  return 1 + (mod - 1) * (0.7 + 0.6 * intensity);
}

/** Layer a secondary direction on top of a primary one at reduced weight. */
function blendMod(primary, secondary, weight = 0.5) {
  return primary * (1 + weight * (secondary - 1));
}

function collectEmotions(source) {
  if (!source) return [];
  const matches = [];
  for (const item of EMOTION_PATTERNS) {
    if (item.regex.test(source)) matches.push(item.emotion);
  }
  return matches;
}

/**
 * Analyzes dialogue text and parenthetical to compute full performance metadata.
 *
 * @param {string}  text          Raw line text
 * @param {string}  parenthetical Direction in parentheses, without the parens
 * @param {string}  speakerType   CHARACTER | DIALOGUE | ACTION | SCENE_HEADING | TRANSITION
 * @param {string}  extension     Character cue extension, e.g. "(V.O.)" or "(O.S.)"
 * @param {boolean} cutOff        Someone talks over the end of this line
 * @param {boolean} pickUp        This line opens by cutting into another
 */
export function analyzeLineNuance({
  text,
  parenthetical = '',
  speakerType = 'CHARACTER',
  extension = '',
  cutOff = false,
  pickUp = false,
}) {
  const rawText = (text || '').trim();
  const isNarration = speakerType === 'ACTION' || speakerType === 'SCENE_HEADING' || speakerType === 'TRANSITION';

  // 1. Explicit direction wins. Collect every cue in it, not just the first.
  let matched = collectEmotions(parenthetical);
  const isBeat = BEAT_REGEX.test(parenthetical || '');
  let directionSource = parenthetical;

  // 2. Fall back to reading the line itself only when there is no direction.
  if (matched.length === 0 && !isBeat && rawText) {
    if (!isNarration) {
      const words = rawText.split(/\s+/);
      const capsWords = words.filter(
        (w) =>
          w.length > 2 && w === w.toUpperCase() && /^[A-Z!?,.']+$/.test(w) && !ACRONYMS.has(w.replace(/[!?,.']/g, '')),
      );
      if (
        (capsWords.length >= 2 && rawText.includes('!')) ||
        (words.length <= 4 && capsWords.length >= 1 && rawText.includes('!'))
      ) {
        matched = [EMOTIONS.SHOUT];
      } else if (rawText.includes('!!')) {
        matched = [EMOTIONS.ANGRY];
      } else if (rawText.includes('...')) {
        matched = [EMOTIONS.HESITANT];
      }
    }

    // Never infer a performance from the words of a stage direction. "COMMANDER
    // CHEN (30s, weary...)" describes the character, not how the narrator should
    // sound reading it — and "INT. COMMAND MODULE" is not an order.
    if (matched.length === 0 && !isNarration) {
      matched = collectEmotions(rawText).slice(0, 1);
      if (matched.length > 0) directionSource = rawText;
    }
  }

  // 3. Character cue extensions colour the whole line: (V.O.) and (O.S.) are not
  //    in the room with the other actors.
  const ext = (extension || '').toUpperCase();
  const isVoiceOver = /\(V\.?O\.?\)/.test(ext);
  const isOffScreen = /\(O\.?S\.?\)|\(OFF\)/.test(ext);

  const primary = matched[0] || (isNarration ? EMOTIONS.NARRATION : EMOTIONS.NEUTRAL);
  const secondary = matched[1] || null;

  const intensity = measureIntensity(rawText);

  let speedMod = scaleMod(primary.speedMod, intensity);
  let pitchMod = scaleMod(primary.pitchMod, intensity);
  let gainMod = scaleMod(primary.gainMod, intensity);
  let filter = primary.filter;

  if (secondary) {
    speedMod = blendMod(speedMod, scaleMod(secondary.speedMod, intensity));
    pitchMod = blendMod(pitchMod, scaleMod(secondary.pitchMod, intensity));
    gainMod = blendMod(gainMod, scaleMod(secondary.gainMod, intensity));
    if (!filter && secondary.filter) filter = secondary.filter;
  }

  if (!filter && isOffScreen) filter = 'distant';
  if (!filter && isVoiceOver && primary.key === 'neutral') gainMod *= 0.95;

  const cleanSpeech = cleanSpeechForSynthesis(text, speakerType, { cutOff, pickUp });
  const isQuestion = cleanSpeech.endsWith('?');
  const isExclamation = cleanSpeech.endsWith('!');

  // Questions lift at the end; exclamations push a little harder.
  if (isQuestion) pitchMod *= 1.015;
  if (isExclamation) gainMod *= 1.05;

  let leadPauseMs = primary.leadPauseMs;
  if (isBeat) leadPauseMs = Math.max(leadPauseMs, EMOTIONS.BEAT.leadPauseMs);

  const displayEmotion = isBeat && matched.length === 0 ? EMOTIONS.BEAT : primary;

  return {
    emotionKey: displayEmotion.key,
    emotionLabel: displayEmotion.label,
    emotionIcon: displayEmotion.icon,
    badgeColor: displayEmotion.badgeColor,
    description: displayEmotion.description,
    directionText: (parenthetical || '').replace(/^\(|\)$/g, '').trim(),
    secondaryKey: secondary ? secondary.key : null,
    matchedSource: directionSource,

    cleanSpeech,
    speedMod,
    pitchMod,
    gainMod,
    leadPauseMs,
    filter,
    intensity,

    isQuestion,
    isExclamation,
    isBeat,
    isVoiceOver,
    isOffScreen,
    isCutOff: cutOff,
    isPickUp: pickUp,
  };
}

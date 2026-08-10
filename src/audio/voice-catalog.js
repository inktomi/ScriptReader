/**
 * Voice Catalog for Local High-Quality TTS
 * Features Kokoro-82M neural voices and Web Speech API mapped profiles
 * Covering diverse sexes, age groups, accents, and emotional timbres.
 */

export const VOICE_CATALOG = [
  // --- FEMALE VOICES ---
  {
    id: 'af_heart',
    kokoroId: 'af_heart',
    name: 'Heart',
    sex: 'Female',
    ageGroup: 'Adult (28-40)',
    accent: 'American',
    tone: 'Warm, Expressive & Empathetic',
    description: 'Rich emotional range, crystal clear prosody. Perfect for nuanced lead roles and heartfelt moments.',
    avatarBg: 'linear-gradient(135deg, #EC4899, #F43F5E)',
    suggestedRoles: ['Lead Protagonist', 'Romantic Lead', 'Empathetic Guide'],
    defaultPitch: 1.0,
    defaultSpeed: 1.0,
    sampleLine: "I never thought we'd make it this far... but looking at you now, I believe we can change everything.",
    qualityGrade: 'S-Tier Neural'
  },
  {
    id: 'af_bella',
    kokoroId: 'af_bella',
    name: 'Bella',
    sex: 'Female',
    ageGroup: 'Young Adult (18-26)',
    accent: 'American',
    tone: 'Bright, Spirited & Dynamic',
    description: 'Youthful energy and quick wit with natural phrasing. Great for vibrant heroines and sharp dialogue.',
    avatarBg: 'linear-gradient(135deg, #F59E0B, #EF4444)',
    suggestedRoles: ['Young Heroine', 'Spirited Rebel', 'Tech Prodigy'],
    defaultPitch: 1.05,
    defaultSpeed: 1.02,
    sampleLine: "Wait, hold on! If we override the mainframe before the timer hits zero, the whole system drops!",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'af_nicole',
    kokoroId: 'af_nicole',
    name: 'Nicole',
    sex: 'Female',
    ageGroup: 'Adult (30-45)',
    accent: 'American',
    tone: 'Smooth, Melodic & Professional',
    description: 'Calm, confident, and articulate with measured cadence. Ideal for commanders, lawyers, and leaders.',
    avatarBg: 'linear-gradient(135deg, #8B5CF6, #6366F1)',
    suggestedRoles: ['Commander', 'Detective', 'Corporate Executive'],
    defaultPitch: 0.98,
    defaultSpeed: 0.98,
    sampleLine: "We have exactly three minutes before security locks down this sector. Keep your head down and follow my lead.",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'af_sarah',
    kokoroId: 'af_sarah',
    name: 'Sarah',
    sex: 'Female',
    ageGroup: 'Adult (28-38)',
    accent: 'American',
    tone: 'Grounded, Conversational & Authentic',
    description: 'Down-to-earth realism with subtle emotional shifts. Fits everyday drama, comedy, and suspense.',
    avatarBg: 'linear-gradient(135deg, #10B981, #059669)',
    suggestedRoles: ['Everyday Lead', 'Doctor', 'Investigator'],
    defaultPitch: 1.0,
    defaultSpeed: 1.0,
    sampleLine: "Are you serious right now? We talked about this. You promised you wouldn't go back there.",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'af_sky',
    kokoroId: 'af_sky',
    name: 'Sky',
    sex: 'Female',
    ageGroup: 'Teen / Young (16-24)',
    accent: 'American',
    tone: 'Modern, Crisp & Agile',
    description: 'Fresh, snappy, and modern delivery. Great for coming-of-age stories, teens, and cyberpunk characters.',
    avatarBg: 'linear-gradient(135deg, #06B6D4, #3B82F6)',
    suggestedRoles: ['Teenager', 'Hacker', 'Adventurer'],
    defaultPitch: 1.08,
    defaultSpeed: 1.05,
    sampleLine: "Check this out. I bypassed their security protocol in less than thirty seconds. Easy peasy.",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'af_river',
    kokoroId: 'af_river',
    name: 'River',
    sex: 'Female',
    ageGroup: 'Adult (25-40)',
    accent: 'American',
    tone: 'Gentle, Intimate & Whispering',
    description: 'Soft, breathy undertones with soothing emotional depth. Perfect for secrets, ghosts, and quiet scenes.',
    avatarBg: 'linear-gradient(135deg, #14B8A6, #0D9488)',
    suggestedRoles: ['Mysterious Figure', 'Ghost', 'Healer / Confidante'],
    defaultPitch: 0.95,
    defaultSpeed: 0.92,
    sampleLine: "Listen closely... If you step into that shadows tonight, there is no turning back.",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'bf_emma',
    kokoroId: 'bf_emma',
    name: 'Emma',
    sex: 'Female',
    ageGroup: 'Adult (25-45)',
    accent: 'British',
    tone: 'Cultured, Refined & Theatrical',
    description: 'Crisp British diction with dramatic flair. Splendid for period pieces, aristocrats, and narrators.',
    avatarBg: 'linear-gradient(135deg, #D97706, #B45309)',
    suggestedRoles: ['British Narrator', 'Aristocrat', 'Clever Sleuth'],
    defaultPitch: 1.0,
    defaultSpeed: 0.98,
    sampleLine: "It was, by all accounts, the most peculiar evening London had witnessed in over half a century.",
    qualityGrade: 'S-Tier Neural'
  },
  {
    id: 'bf_isabella',
    kokoroId: 'bf_isabella',
    name: 'Isabella',
    sex: 'Female',
    ageGroup: 'Mature (35-55)',
    accent: 'British',
    tone: 'Regal, Dramatic & Commanding',
    description: 'Deep, commanding British timbre. Ideal for royalty, matriarchs, villains, and sophisticated roles.',
    avatarBg: 'linear-gradient(135deg, #7C3AED, #5B21B6)',
    suggestedRoles: ['Queen / Matriarch', 'Villainess', 'Senior Judge'],
    defaultPitch: 0.92,
    defaultSpeed: 0.95,
    sampleLine: "You dare enter my court and speak of treason? You will answer for your insolence before dawn.",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'bf_lily',
    kokoroId: 'bf_lily',
    name: 'Lily',
    sex: 'Female',
    ageGroup: 'Child / Teen (10-17)',
    accent: 'British',
    tone: 'Delicate, Sweet & Innocent',
    description: 'Light, youthful and innocent British tone for young daughters, fairies, and magical characters.',
    avatarBg: 'linear-gradient(135deg, #F472B6, #DB2777)',
    suggestedRoles: ['Child', 'Innocent Witness', 'Magical Guide'],
    defaultPitch: 1.15,
    defaultSpeed: 1.02,
    sampleLine: "Father! Look what I found buried beneath the old willow tree by the lake!",
    qualityGrade: 'A-Tier Neural'
  },

  // --- MALE VOICES ---
  {
    id: 'am_adam',
    kokoroId: 'am_adam',
    name: 'Adam',
    sex: 'Male',
    ageGroup: 'Adult (28-42)',
    accent: 'American',
    tone: 'Natural, Grounded & Conversational',
    description: 'Versatile, friendly American male voice with genuine human pacing. Ideal for leading men and detectives.',
    avatarBg: 'linear-gradient(135deg, #3B82F6, #1D4ED8)',
    suggestedRoles: ['Lead Protagonist', 'Detective', 'Reluctant Hero'],
    defaultPitch: 1.0,
    defaultSpeed: 1.0,
    sampleLine: "I spent three years looking for the truth. And now that I've found it, I wish I hadn't.",
    qualityGrade: 'S-Tier Neural'
  },
  {
    id: 'am_onyx',
    kokoroId: 'am_onyx',
    name: 'Onyx',
    sex: 'Male',
    ageGroup: 'Mature (38-60)',
    accent: 'American',
    tone: 'Deep Baritone, Gravelly & Menacing',
    description: 'Rich, gravel-laced bass with spine-chilling presence. Perfect for villains, grim anti-heroes, and noir narrators.',
    avatarBg: 'linear-gradient(135deg, #1E293B, #0F172A)',
    suggestedRoles: ['Main Villain', 'Grim Anti-Hero', 'Noir Narrator', 'Mob Boss'],
    defaultPitch: 0.85,
    defaultSpeed: 0.92,
    sampleLine: "The city eats people like you for breakfast. You walked right into my crosshairs, detective.",
    qualityGrade: 'S-Tier Neural'
  },
  {
    id: 'am_fenrir',
    kokoroId: 'am_fenrir',
    name: 'Fenrir',
    sex: 'Male',
    ageGroup: 'Adult (25-45)',
    accent: 'American',
    tone: 'Gritty, Intense & Raw',
    description: 'Rough, action-ready cadence full of urgency and tension. Ideal for warriors, gritty cops, and survivors.',
    avatarBg: 'linear-gradient(135deg, #EF4444, #B91C1C)',
    suggestedRoles: ['Warrior', 'Soldier', 'Hardboiled Cop', 'Rogue'],
    defaultPitch: 0.92,
    defaultSpeed: 1.05,
    sampleLine: "Incoming! Get behind the barricade right now! Reloading, cover me!",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'am_echo',
    kokoroId: 'am_echo',
    name: 'Echo',
    sex: 'Male',
    ageGroup: 'Adult (32-50)',
    accent: 'American',
    tone: 'Resonant, Clear & Cinematic',
    description: 'Commanding, velvety resonance with flawless projection. Excellent for cinematic narration and leads.',
    avatarBg: 'linear-gradient(135deg, #6366F1, #4F46E5)',
    suggestedRoles: ['Cinematic Narrator', 'Space Commander', 'Scientist'],
    defaultPitch: 0.95,
    defaultSpeed: 0.98,
    sampleLine: "The telemetry confirmed our worst fears: the containment field had failed completely.",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'am_liam',
    kokoroId: 'am_liam',
    name: 'Liam',
    sex: 'Male',
    ageGroup: 'Young Adult (18-28)',
    accent: 'American',
    tone: 'Sharp, Energetic & Confident',
    description: 'Youthful enthusiasm with quick comedic timing and snappy reactions. Great for sidekicks and rookie heroes.',
    avatarBg: 'linear-gradient(135deg, #10B981, #047857)',
    suggestedRoles: ['Rookie Cop', 'Comedy Sidekick', 'Young Adventurer'],
    defaultPitch: 1.04,
    defaultSpeed: 1.05,
    sampleLine: "Okay, don't freak out, but I might have accidentally triggered the silent alarm. Run!",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'am_michael',
    kokoroId: 'am_michael',
    name: 'Michael',
    sex: 'Male',
    ageGroup: 'Mature (40-60)',
    accent: 'American',
    tone: 'Warm Storyteller & Wise Mentor',
    description: 'Seasoned, reassuring baritone with fatherly warmth. Ideal for mentors, professors, and fathers.',
    avatarBg: 'linear-gradient(135deg, #D97706, #78350F)',
    suggestedRoles: ['Wise Mentor', 'Father Figure', 'Professor'],
    defaultPitch: 0.94,
    defaultSpeed: 0.95,
    sampleLine: "Courage isn't the absence of fear, son. It's doing what must be done despite being terrified.",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'am_puck',
    kokoroId: 'am_puck',
    name: 'Puck',
    sex: 'Male',
    ageGroup: 'Young / Quirky (16-30)',
    accent: 'American',
    tone: 'Playful, Mischievous & Sarcastic',
    description: 'Quirky cadence with dynamic pitch swings. Perfect for tricksters, sarcastic hackers, and comedic relief.',
    avatarBg: 'linear-gradient(135deg, #A855F7, #7E22CE)',
    suggestedRoles: ['Trickster', 'Sarcastic Hacker', 'Comedic Relief'],
    defaultPitch: 1.08,
    defaultSpeed: 1.08,
    sampleLine: "Oh, brilliant plan! Truly a masterpiece of catastrophic failure. What could possibly go wrong?",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'am_santa',
    kokoroId: 'am_santa',
    name: 'Elder Marcus',
    kokoroIdVoice: 'am_santa',
    nameRaw: 'am_santa',
    sex: 'Male',
    ageGroup: 'Senior (60-80)',
    accent: 'American',
    tone: 'Elderly, Deep, Jolly & Resonant',
    description: 'Rumbling, seasoned elder voice. Perfect for grandfathers, ancient kings, wizards, and sage elders.',
    avatarBg: 'linear-gradient(135deg, #DC2626, #991B1B)',
    suggestedRoles: ['Ancient Sage', 'Grandfather', 'Wizard / Elder'],
    defaultPitch: 0.88,
    defaultSpeed: 0.90,
    sampleLine: "Long before the towers of iron rose against the sky, there was peace across these valleys.",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'bm_george',
    kokoroId: 'bm_george',
    name: 'George',
    sex: 'Male',
    ageGroup: 'Senior / Mature (55-75)',
    accent: 'British',
    tone: 'Dignified, Classic Narrator & Noble',
    description: 'The definitive classic British narrator. Dignified, measured, and timelessly evocative.',
    avatarBg: 'linear-gradient(135deg, #0284C7, #0369A1)',
    suggestedRoles: ['Default Narrator', 'Aristocrat', 'Butler', 'Elderly Statesman'],
    defaultPitch: 0.92,
    defaultSpeed: 0.94,
    sampleLine: "Rain drummed relentlessly against the cobblestones of Baker Street as the midnight bell tolled.",
    qualityGrade: 'S-Tier Neural'
  },
  {
    id: 'bm_lewis',
    kokoroId: 'bm_lewis',
    name: 'Lewis',
    sex: 'Male',
    ageGroup: 'Adult (30-50)',
    accent: 'British',
    tone: 'Theatrical, Sharp & Sophisticated',
    description: 'Crisp theatrical British articulation with dark dramatic undertones. Perfect for British villains and detectives.',
    avatarBg: 'linear-gradient(135deg, #059669, #064E3B)',
    suggestedRoles: ['British Villain', 'Inspector', 'Rival'],
    defaultPitch: 0.96,
    defaultSpeed: 1.0,
    sampleLine: "How delightfully predictable. Did you genuinely presume you could outwit me in my own estate?",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'bm_fable',
    kokoroId: 'bm_fable',
    name: 'Fable',
    sex: 'Male',
    ageGroup: 'Adult (35-55)',
    accent: 'British',
    tone: 'Dramatic, Cinematic & Captivating',
    description: 'Evocative storytelling cadence with rich pauses and dramatic emphasis. Excellent for audiobook and screenplay action.',
    avatarBg: 'linear-gradient(135deg, #D97706, #451A03)',
    suggestedRoles: ['Action Narrator', 'Mythic Hero', 'Historian'],
    defaultPitch: 0.94,
    defaultSpeed: 0.96,
    sampleLine: "The doors groaned open, revealing the ancient chamber swallowed in centuries of dust.",
    qualityGrade: 'A-Tier Neural'
  },
  {
    id: 'bm_daniel',
    kokoroId: 'bm_daniel',
    name: 'Daniel',
    sex: 'Male',
    ageGroup: 'Adult (30-48)',
    accent: 'British',
    tone: 'Formal, Articulate & Precise',
    description: 'Polished RP British cadence with clinical precision. Great for doctors, scientists, and diplomats.',
    avatarBg: 'linear-gradient(135deg, #475569, #1E293B)',
    suggestedRoles: ['Doctor', 'Scientist', 'Diplomat', 'Butler'],
    defaultPitch: 0.98,
    defaultSpeed: 0.98,
    sampleLine: "According to the preliminary forensic report, the artifact was activated at approximately two in the morning.",
    qualityGrade: 'A-Tier Neural'
  }
];

export function getVoiceById(id) {
  return VOICE_CATALOG.find(v => v.id === id) || VOICE_CATALOG[0];
}

export function getDefaultNarratorVoice() {
  return VOICE_CATALOG.find(v => v.id === 'bm_george') || VOICE_CATALOG[0];
}

export function getSuggestedVoiceForCharacter(characterName, context = {}) {
  const name = characterName.toUpperCase().trim();
  const usedVoices = context.usedVoices || new Set();
  
  // Narrator / Scene
  if (name.includes('NARRATOR') || name.includes('STAGE') || name.includes('SCENE')) {
    return 'bm_george';
  }

  // Common Female names/clues
  const femaleKeywords = [
    'SARAH', 'KIRA', 'EVELYN', 'ELIZABETH', 'JANE', 'MARY', 'LUCY', 'ANNA', 'EMMA', 'ISABELLA', 
    'LILY', 'HELEN', 'ALICE', 'EVA', 'CHLOE', 'ZOE', 'MIA', 'SOPHIE', 'CLAIRE', 'MOTHER', 
    'QUEEN', 'WOMAN', 'GIRL', 'DAUGHTER', 'SISTER', 'LADY', 'MRS', 'MISS', 'MS', 'HER', 'NICOLE', 'BELLA', 'VALENTINA', 'CHEN'
  ];
  
  // Villains / Dark characters
  const villainKeywords = ['SHADOW', 'BOSS', 'KILLER', 'ONYX', 'VILLAIN', 'BARON', 'LORD', 'MASTER', 'ASSASSIN', 'MONSTER', 'STRANGER'];
  
  // Gritty / Action characters
  const grittyKeywords = ['FENRIR', 'VALENTINE', 'JACK', 'SOLDIER', 'CAPTAIN', 'GUARD', 'SERGEANT', 'GRUNT', 'MILLER', 'BRIGGS'];
  
  // Elders / Seniors
  const elderKeywords = ['OLD', 'ELDER', 'PEMBERTON', 'GRANDFATHER', 'PROFESSOR', 'DOCTOR', 'DOC', 'WIZARD', 'HIGGINS', 'PRIEST'];

  // Detect gender & type
  const isFemale = femaleKeywords.some(kw => name.includes(kw));
  let candidate = null;
  
  if (villainKeywords.some(kw => name.includes(kw))) {
    candidate = isFemale ? 'bf_isabella' : 'am_onyx';
  } else if (elderKeywords.some(kw => name.includes(kw))) {
    candidate = isFemale ? 'bf_isabella' : 'am_santa';
  } else if (grittyKeywords.some(kw => name.includes(kw))) {
    candidate = isFemale ? 'af_bella' : 'am_fenrir';
  } else if (isFemale) {
    if (name.includes('YOUNG') || name.includes('GIRL') || name.includes('TEEN')) candidate = 'af_bella';
    else if (name.includes('LADY') || name.includes('BRITISH') || name.includes('DUCHESS')) candidate = 'bf_emma';
    else if (name.includes('AI') || name.includes('COMPUTER') || name.includes('SYSTEM')) candidate = 'af_nicole';
    else candidate = 'af_heart';
  } else {
    // Male defaults
    if (name.includes('YOUNG') || name.includes('BOY') || name.includes('ROOKIE')) candidate = 'am_liam';
    else if (name.includes('DETECTIVE') || name.includes('INSPECTOR') || name.includes('COP')) candidate = 'am_adam';
    else if (name.includes('AI') || name.includes('VOICE') || name.includes('ANNOUNCER')) candidate = 'am_echo';
  }

  // If candidate is available and unused, use it
  if (candidate && !usedVoices.has(candidate)) {
    return candidate;
  }

  // Otherwise, select the best unused voice from appropriate gender pool
  const pool = VOICE_CATALOG.filter(v => v.sex === (isFemale ? 'Female' : 'Male') && v.id !== 'bm_george');
  const unusedInPool = pool.filter(v => !usedVoices.has(v.id));

  if (unusedInPool.length > 0) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return unusedInPool[hash % unusedInPool.length].id;
  }

  return candidate || (isFemale ? 'af_heart' : 'am_adam');
}

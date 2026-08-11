/**
 * Voice Catalog for Local High-Quality TTS
 *
 * Kokoro-82M neural voices covering a range of sexes, age groups, accents, and
 * timbres. Everything descriptive here — tone, suggested roles, sample lines —
 * is ours; the objective quality ranking lives in `voice-grades.js` and comes
 * from upstream, so the two cannot drift apart.
 */

import {
  KOKORO_GRADES,
  gradeScore,
  byGradeDesc,
  isCastable,
  CASTABLE_SCORE
} from './voice-grades.js';
import { ENGINE_IDS } from './engine-contract.js';

export { KOKORO_GRADES, gradeScore, isCastable, CASTABLE_SCORE };

const VOICE_PROFILES = [
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
    sampleLine: "I never thought we'd make it this far... but looking at you now, I believe we can change everything."
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
    sampleLine: "Wait, hold on! If we override the mainframe before the timer hits zero, the whole system drops!"
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
    sampleLine: "We have exactly three minutes before security locks down this sector. Keep your head down and follow my lead."
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
    sampleLine: "Are you serious right now? We talked about this. You promised you wouldn't go back there."
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
    sampleLine: "Check this out. I bypassed their security protocol in less than thirty seconds. Easy peasy."
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
    sampleLine: "Listen closely... If you step into that shadows tonight, there is no turning back."
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
    sampleLine: "It was, by all accounts, the most peculiar evening London had witnessed in over half a century."
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
    sampleLine: "You dare enter my court and speak of treason? You will answer for your insolence before dawn."
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
    sampleLine: "Father! Look what I found buried beneath the old willow tree by the lake!"
  },

  // These four were already being downloaded by ModelCacheManager's preload —
  // their embeddings have been sitting on disk this whole time — but they were
  // never added here, so nothing could select them. Two of them (Aoede, Kore)
  // outrank most of the voices that were selectable.
  {
    id: 'af_aoede',
    kokoroId: 'af_aoede',
    name: 'Aoede',
    sex: 'Female',
    ageGroup: 'Adult (26-38)',
    accent: 'American',
    tone: 'Lyrical, Poised & Measured',
    description: 'Even, unhurried phrasing with a musical lift. Suits composed leads, counsel, and reflective narration.',
    avatarBg: 'linear-gradient(135deg, #6366F1, #8B5CF6)',
    suggestedRoles: ['Composed Lead', 'Counsel', 'Reflective Narrator'],
    defaultPitch: 1.0,
    defaultSpeed: 0.99,
    sampleLine: "I read the file twice. Neither time did it say what you claim it says."
  },
  {
    id: 'af_kore',
    kokoroId: 'af_kore',
    name: 'Kore',
    sex: 'Female',
    ageGroup: 'Adult (24-36)',
    accent: 'American',
    tone: 'Clear, Direct & Unadorned',
    description: 'Plain-spoken and precise with little ornament. Good for procedurals, professionals, and skeptics.',
    avatarBg: 'linear-gradient(135deg, #0EA5E9, #0369A1)',
    suggestedRoles: ['Investigator', 'Engineer', 'Skeptic'],
    defaultPitch: 1.02,
    defaultSpeed: 1.0,
    sampleLine: "That's not what the timestamps show. Somebody went back and changed them."
  },
  {
    id: 'af_alloy',
    kokoroId: 'af_alloy',
    name: 'Alloy',
    sex: 'Female',
    ageGroup: 'Adult (28-42)',
    accent: 'American',
    tone: 'Even, Neutral & Procedural',
    description: 'Deliberately flat and unhurried. Fits dispatchers, systems, bureaucrats, and anything that should not emote.',
    avatarBg: 'linear-gradient(135deg, #64748B, #334155)',
    suggestedRoles: ['Dispatcher', 'AI / System', 'Official'],
    defaultPitch: 0.99,
    defaultSpeed: 1.0,
    sampleLine: "Access denied. This incident has been logged and forwarded to compliance."
  },
  {
    id: 'af_nova',
    kokoroId: 'af_nova',
    name: 'Nova',
    sex: 'Female',
    ageGroup: 'Young Adult (20-30)',
    accent: 'American',
    tone: 'Buoyant, Forward & Quick',
    description: 'Bright and fast off the mark, riding the top of the breath. Great for banter and eager newcomers.',
    avatarBg: 'linear-gradient(135deg, #F472B6, #C026D3)',
    suggestedRoles: ['Eager Newcomer', 'Best Friend', 'Reporter'],
    defaultPitch: 1.04,
    defaultSpeed: 1.03,
    sampleLine: "Wait, wait — say that again, but slower, because I think you just solved it."
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
    sampleLine: "I spent three years looking for the truth. And now that I've found it, I wish I hadn't."
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
    sampleLine: "The city eats people like you for breakfast. You walked right into my crosshairs, detective."
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
    sampleLine: "Incoming! Get behind the barricade right now! Reloading, cover me!"
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
    sampleLine: "The telemetry confirmed our worst fears: the containment field had failed completely."
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
    sampleLine: "Okay, don't freak out, but I might have accidentally triggered the silent alarm. Run!"
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
    sampleLine: "Courage isn't the absence of fear, son. It's doing what must be done despite being terrified."
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
    sampleLine: "Oh, brilliant plan! Truly a masterpiece of catastrophic failure. What could possibly go wrong?"
  },
  {
    id: 'am_santa',
    kokoroId: 'am_santa',
    name: 'Elder Marcus',
    sex: 'Male',
    ageGroup: 'Senior (60-80)',
    accent: 'American',
    tone: 'Elderly, Deep, Jolly & Resonant',
    description: 'Rumbling, seasoned elder voice. Perfect for grandfathers, ancient kings, wizards, and sage elders.',
    avatarBg: 'linear-gradient(135deg, #DC2626, #991B1B)',
    suggestedRoles: ['Ancient Sage', 'Grandfather', 'Wizard / Elder'],
    defaultPitch: 0.88,
    defaultSpeed: 0.90,
    sampleLine: "Long before the towers of iron rose against the sky, there was peace across these valleys."
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
    sampleLine: "Rain drummed relentlessly against the cobblestones of Baker Street as the midnight bell tolled."
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
    sampleLine: "How delightfully predictable. Did you genuinely presume you could outwit me in my own estate?"
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
    sampleLine: "The doors groaned open, revealing the ancient chamber swallowed in centuries of dust."
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
    sampleLine: "According to the preliminary forensic report, the artifact was activated at approximately two in the morning."
  }
];

/**
 * OpenAI `gpt-4o-mini-tts` voices.
 *
 * Same field shape as the Kokoro profiles on purpose — the casting UI renders
 * either pool with no template changes.
 *
 * Every `defaultPitch` and `defaultSpeed` is exactly 1.0, which is not laziness.
 * On this engine those two numbers do not drive a synthesis parameter; they
 * select a band in the instruction text. A profile sitting at 0.92 would pin
 * every one of that character's lines into a "lower register" instruction
 * permanently, whatever the scene called for. Character is carried by `tone` and
 * by the per-character direction the user writes.
 *
 * Ordered with OpenAI's two documented best-quality voices first. Notably this
 * pool is male-rich, which is where the Kokoro catalog is thinnest.
 */
const OPENAI_VOICE_PROFILES = [
  {
    id: 'marin', name: 'Marin', sex: 'Female', ageGroup: 'Adult (28-45)', accent: 'American',
    tone: 'Natural, Warm & Highly Expressive',
    description: "OpenAI's highest-quality female voice. Wide emotional range and convincing conversational rhythm.",
    avatarBg: 'linear-gradient(135deg, #EC4899, #BE185D)',
    suggestedRoles: ['Lead', 'Narrator', 'Anything demanding'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "I read the file twice. Neither time did it say what you claim it says."
  },
  {
    id: 'cedar', name: 'Cedar', sex: 'Male', ageGroup: 'Adult (30-50)', accent: 'American',
    tone: 'Natural, Grounded & Highly Expressive',
    description: "OpenAI's highest-quality male voice. Believable weight and restraint; holds a long speech.",
    avatarBg: 'linear-gradient(135deg, #0EA5E9, #0C4A6E)',
    suggestedRoles: ['Lead', 'Narrator', 'Anything demanding'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "I spent three years looking for the truth. Now that I have it, I wish I hadn't."
  },
  {
    id: 'coral', name: 'Coral', sex: 'Female', ageGroup: 'Adult (26-40)', accent: 'American',
    tone: 'Warm, Bright & Engaged',
    description: 'Friendly and forward with an easy smile in the voice. Good for empathetic leads and best friends.',
    avatarBg: 'linear-gradient(135deg, #FB7185, #E11D48)',
    suggestedRoles: ['Empathetic Lead', 'Best Friend', 'Host'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "Hey — look at me. We are going to figure this out, alright?"
  },
  {
    id: 'sage', name: 'Sage', sex: 'Female', ageGroup: 'Adult (30-48)', accent: 'American',
    tone: 'Measured, Composed & Authoritative',
    description: 'Calm and deliberate with natural gravity. Fits commanders, counsel, and physicians.',
    avatarBg: 'linear-gradient(135deg, #8B5CF6, #5B21B6)',
    suggestedRoles: ['Commander', 'Counsel', 'Physician'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "We have three minutes before this sector locks down. Follow my lead."
  },
  {
    id: 'shimmer', name: 'Shimmer', sex: 'Female', ageGroup: 'Adult (24-38)', accent: 'American',
    tone: 'Soft, Close & Intimate',
    description: 'Gentle and breathy with a confiding quality. Suits secrets, grief, and quiet two-handers.',
    avatarBg: 'linear-gradient(135deg, #2DD4BF, #0F766E)',
    suggestedRoles: ['Confidante', 'Ghost', 'Quiet Scenes'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "Listen closely. If you walk into that room tonight, there is no coming back."
  },
  {
    id: 'nova', name: 'Nova', sex: 'Female', ageGroup: 'Young Adult (20-32)', accent: 'American',
    tone: 'Quick, Bright & Energetic',
    description: 'Fast off the mark and eager. Great for banter, reporters, and rookies.',
    avatarBg: 'linear-gradient(135deg, #F59E0B, #D97706)',
    suggestedRoles: ['Rookie', 'Reporter', 'Comic Relief'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "Wait — say that again, slower, because I think you just solved it."
  },
  {
    id: 'ash', name: 'Ash', sex: 'Male', ageGroup: 'Adult (28-45)', accent: 'American',
    tone: 'Gritty, Textured & Direct',
    description: 'Rough-edged and unpolished in a good way. Fits soldiers, hardboiled cops, and survivors.',
    avatarBg: 'linear-gradient(135deg, #EF4444, #7F1D1D)',
    suggestedRoles: ['Soldier', 'Hardboiled Cop', 'Survivor'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "Get behind the barricade. Now. I'm not asking you twice."
  },
  {
    id: 'onyx', name: 'Onyx', sex: 'Male', ageGroup: 'Mature (38-60)', accent: 'American',
    tone: 'Deep Baritone, Weighted & Menacing',
    description: 'Low and unhurried with real threat underneath. The obvious villain and noir narrator.',
    avatarBg: 'linear-gradient(135deg, #1E293B, #020617)',
    suggestedRoles: ['Villain', 'Mob Boss', 'Noir Narrator'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "This city eats people like you. You walked into my crosshairs, detective."
  },
  {
    id: 'echo', name: 'Echo', sex: 'Male', ageGroup: 'Adult (32-50)', accent: 'American',
    tone: 'Resonant, Even & Cinematic',
    description: 'Clean projection with trailer-voice authority. Good for narration and command roles.',
    avatarBg: 'linear-gradient(135deg, #6366F1, #3730A3)',
    suggestedRoles: ['Cinematic Narrator', 'Commander', 'Scientist'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "Telemetry confirmed our worst fears. The containment field had failed."
  },
  {
    id: 'fable', name: 'Fable', sex: 'Male', ageGroup: 'Adult (32-52)', accent: 'British',
    tone: 'Storytelling, Characterful & British',
    description: 'Expressive British storyteller with generous pauses. Strong for action narration and period pieces.',
    avatarBg: 'linear-gradient(135deg, #D97706, #78350F)',
    suggestedRoles: ['British Narrator', 'Historian', 'Mythic Hero'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "The doors groaned open, revealing a chamber swallowed in centuries of dust."
  },
  {
    id: 'ballad', name: 'Ballad', sex: 'Male', ageGroup: 'Adult (30-50)', accent: 'British',
    tone: 'Theatrical, Lyrical & Emotive',
    description: 'The most overtly dramatic of the set. Leans into pathos — good for stage-sized moments.',
    avatarBg: 'linear-gradient(135deg, #A855F7, #6B21A8)',
    suggestedRoles: ['Tragic Lead', 'Aristocrat', 'Stage Villain'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "How delightfully predictable. Did you truly think you could outwit me here?"
  },
  {
    id: 'verse', name: 'Verse', sex: 'Male', ageGroup: 'Young Adult (22-34)', accent: 'American',
    tone: 'Agile, Expressive & Conversational',
    description: 'Light and quick with good comic timing. Fits sidekicks, hackers, and younger leads.',
    avatarBg: 'linear-gradient(135deg, #10B981, #065F46)',
    suggestedRoles: ['Sidekick', 'Hacker', 'Young Lead'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "Don't freak out, but I may have just tripped the silent alarm. Run."
  },
  {
    id: 'alloy', name: 'Alloy', sex: 'Neutral', ageGroup: 'Adult (28-45)', accent: 'American',
    tone: 'Even, Neutral & Unemotive',
    description: 'Deliberately flat and androgynous. The right choice for systems, dispatch, and anything inhuman.',
    avatarBg: 'linear-gradient(135deg, #64748B, #1E293B)',
    suggestedRoles: ['AI / System', 'Dispatcher', 'Official'],
    defaultPitch: 1.0, defaultSpeed: 1.0,
    sampleLine: "Access denied. This incident has been logged and forwarded to compliance."
  }
];

/**
 * Best first. Sorting once here means both `<select>` builders render in quality
 * order and the auto-caster's "first unused voice" is automatically "best unused
 * voice" — no call site has to know grades exist.
 */
export const VOICE_CATALOG = [...VOICE_PROFILES].sort(byGradeDesc);

export const OPENAI_VOICE_CATALOG = OPENAI_VOICE_PROFILES;

/** Every voice the given engine can actually speak with. */
export function getVoicesForEngine(engineId) {
  return engineId === ENGINE_IDS.OPENAI ? OPENAI_VOICE_CATALOG : VOICE_CATALOG;
}

/**
 * Seeds a character's voice when switching to an engine they have no assignment
 * for. Hand-written rather than derived, because "who does this voice sound
 * like on the other engine" is a judgement no metadata captures.
 */
export const CROSS_ENGINE_VOICE_MAP = Object.freeze({
  af_heart: 'marin', af_bella: 'nova', af_nicole: 'sage', af_sarah: 'coral',
  af_aoede: 'sage', af_kore: 'coral', af_alloy: 'alloy', af_nova: 'nova',
  af_sky: 'nova', af_river: 'shimmer', af_jessica: 'coral',
  bf_emma: 'ballad', bf_isabella: 'sage', bf_lily: 'nova', bf_alice: 'shimmer',
  am_fenrir: 'ash', am_michael: 'cedar', am_puck: 'verse', am_onyx: 'onyx',
  am_adam: 'cedar', am_echo: 'echo', am_liam: 'verse', am_eric: 'ash',
  am_santa: 'onyx', bm_george: 'fable', bm_fable: 'fable', bm_lewis: 'ballad',
  bm_daniel: 'echo'
});

/**
 * Translate an assignment across engines, preferring the hand-written mapping
 * and otherwise taking the best unused voice of the same sex.
 */
export function mapVoiceAcrossEngines(voiceId, targetEngineId, usedVoices = new Set()) {
  const pool = getVoicesForEngine(targetEngineId);

  const mapped = targetEngineId === ENGINE_IDS.OPENAI
    ? CROSS_ENGINE_VOICE_MAP[voiceId]
    : Object.keys(CROSS_ENGINE_VOICE_MAP).find(k => CROSS_ENGINE_VOICE_MAP[k] === voiceId);

  if (mapped && pool.some(v => v.id === mapped) && !usedVoices.has(mapped)) return mapped;

  const source = VOICE_CATALOG.find(v => v.id === voiceId)
    || OPENAI_VOICE_CATALOG.find(v => v.id === voiceId);
  const sex = source ? source.sex : 'Female';

  const sameSex = pool.filter(v => v.sex === sex && !usedVoices.has(v.id));
  if (sameSex.length > 0) return sameSex[0].id;

  const anyUnused = pool.find(v => !usedVoices.has(v.id));
  return anyUnused ? anyUnused.id : pool[0].id;
}

/** Voices good enough to hand out without being asked for. */
export const CASTABLE_VOICES = VOICE_CATALOG.filter(v => isCastable(v.id));

/**
 * The single best voice in the set (grade A). Used wherever code previously
 * reached for `am_adam`, which upstream grades F+.
 */
export const DEFAULT_VOICE_ID = 'af_heart';

/**
 * Narrator default (grade B-), a two-tier jump from the previous `bm_george` (C).
 *
 * Deliberately *not* `af_heart`, even though it grades higher: the narrator is
 * seeded into `usedVoices` before the cast is assigned, so spending the only
 * A-grade voice here would take it away from the largest speaking role. Emma
 * also keeps the classic-British-narrator identity the sample scripts assume.
 */
export const DEFAULT_NARRATOR_VOICE_ID = 'bf_emma';

/**
 * The one place a fresh assignment is constructed. Previously this object was
 * written out by hand in nine places, every one of them naming `am_adam`.
 *
 * `auto: true` records that nobody chose this — which is what lets a later
 * migration re-cast automatic assignments while leaving deliberate ones alone.
 */
export function makeDefaultAssignment(voiceId = DEFAULT_VOICE_ID) {
  return {
    voiceId,
    pitchOffset: 0,
    speedMultiplier: 1.0,
    tonePreset: 'natural',
    auto: true
  };
}

/**
 * Look up a voice profile.
 *
 * With no `engineId`, both pools are searched — callers that only have an id
 * (saved casts, the teleprompter) keep working. With one, the search is scoped
 * to that engine's pool and falls back within it, so a Kokoro id can never
 * resolve to an OpenAI profile or the reverse.
 */
export function getVoiceById(id, engineId = null) {
  if (engineId) {
    const pool = getVoicesForEngine(engineId);
    return pool.find(v => v.id === id) || pool[0];
  }
  return VOICE_CATALOG.find(v => v.id === id)
    || OPENAI_VOICE_CATALOG.find(v => v.id === id)
    || VOICE_CATALOG[0];
}

export function getDefaultNarratorVoice() {
  return VOICE_CATALOG.find(v => v.id === DEFAULT_NARRATOR_VOICE_ID) || VOICE_CATALOG[0];
}

export function isNarratorName(name) {
  const raw = (name || '').toUpperCase().trim();
  return raw.includes('NARRATOR') || raw.includes('STAGE') || raw.includes('SCENE');
}

// Matched as whole tokens, never as substrings. `name.includes('HER')` used to
// gender CHRISTOPHER, LUTHER, USHER and FISHER female; 'MS' caught WILLIAMS and
// 'MIA' caught JEREMIAH.
const FEMALE_KEYWORDS = [
  'SARAH', 'KIRA', 'EVELYN', 'ELIZABETH', 'JANE', 'MARY', 'LUCY', 'ANNA', 'EMMA', 'ISABELLA',
  'LILY', 'HELEN', 'ALICE', 'EVA', 'CHLOE', 'ZOE', 'MIA', 'SOPHIE', 'CLAIRE', 'MOTHER',
  'QUEEN', 'WOMAN', 'GIRL', 'DAUGHTER', 'SISTER', 'LADY', 'MRS', 'MISS', 'MS', 'HER',
  'NICOLE', 'BELLA', 'VALENTINA', 'AUNT', 'GRANDMOTHER', 'WIDOW', 'NUN', 'WAITRESS'
];

const VILLAIN_KEYWORDS = ['SHADOW', 'BOSS', 'KILLER', 'ONYX', 'VILLAIN', 'BARON', 'LORD', 'MASTER', 'ASSASSIN', 'MONSTER', 'STRANGER'];
const GRITTY_KEYWORDS = ['FENRIR', 'VALENTINE', 'JACK', 'SOLDIER', 'CAPTAIN', 'GUARD', 'SERGEANT', 'GRUNT', 'MILLER', 'BRIGGS', 'DETECTIVE', 'INSPECTOR', 'COP'];
const ELDER_KEYWORDS = ['OLD', 'ELDER', 'PEMBERTON', 'GRANDFATHER', 'PROFESSOR', 'DOCTOR', 'DOC', 'WIZARD', 'HIGGINS', 'PRIEST', 'JUDGE'];
const YOUNG_KEYWORDS = ['YOUNG', 'BOY', 'GIRL', 'TEEN', 'ROOKIE', 'KID', 'CHILD'];
const BRITISH_KEYWORDS = ['BRITISH', 'DUCHESS', 'DUKE', 'EARL', 'BUTLER', 'VICAR'];
const SYNTHETIC_KEYWORDS = ['AI', 'COMPUTER', 'SYSTEM', 'ANNOUNCER', 'DISPATCH', 'DISPATCHER', 'INTERCOM', 'RADIO'];

/**
 * Ranked shortlists: intent first, quality as the tiebreak *within* the intent.
 *
 * Every list is grade-ordered internally and contains only castable voices, so
 * exhausting one never lands below what simply taking the next-best voice of that
 * sex would have given. `am_onyx` is absent despite being the obvious villain
 * timbre — it grades D, and a villain is usually a large part.
 */
const ROLE_PREFERENCES = {
  villainF: ['bf_isabella', 'af_nicole', 'bf_emma'],
  villainM: ['am_fenrir', 'am_michael', 'bm_fable'],
  elderF: ['bf_isabella', 'af_nicole', 'af_aoede'],
  elderM: ['am_michael', 'bm_fable', 'bm_george'],
  grittyF: ['af_bella', 'af_kore', 'af_nicole'],
  grittyM: ['am_fenrir', 'am_puck', 'am_michael'],
  youngF: ['af_bella', 'af_nova', 'af_kore'],
  youngM: ['am_puck', 'am_fenrir', 'am_michael'],
  britishF: ['bf_emma', 'bf_isabella'],
  britishM: ['bm_fable', 'bm_george'],
  syntheticF: ['af_alloy', 'af_kore'],
  syntheticM: ['am_michael', 'am_fenrir'],
  defaultF: ['af_heart', 'af_bella', 'af_nicole', 'af_aoede'],
  defaultM: ['am_fenrir', 'am_michael', 'am_puck']
};

/** Deterministic across sessions, so a given cast always lands the same way. */
function stableHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pickShortlist(tokens, isFemale) {
  const has = (list) => list.some(kw => tokens.includes(kw));
  const suffix = isFemale ? 'F' : 'M';

  if (has(VILLAIN_KEYWORDS)) return ROLE_PREFERENCES[`villain${suffix}`];
  if (has(ELDER_KEYWORDS)) return ROLE_PREFERENCES[`elder${suffix}`];
  if (has(GRITTY_KEYWORDS)) return ROLE_PREFERENCES[`gritty${suffix}`];
  if (has(YOUNG_KEYWORDS)) return ROLE_PREFERENCES[`young${suffix}`];
  if (has(BRITISH_KEYWORDS)) return ROLE_PREFERENCES[`british${suffix}`];
  if (has(SYNTHETIC_KEYWORDS)) return ROLE_PREFERENCES[`synthetic${suffix}`];
  return ROLE_PREFERENCES[`default${suffix}`];
}

/**
 * Suggest a voice for a character, preferring quality and never auto-assigning a
 * voice below the castable floor.
 *
 * Callers iterate characters in descending line-count order (both parsers sort
 * `characters` that way), so walking a grade-ranked pool hands the best voices to
 * the biggest parts without anyone arranging it.
 *
 * @param {string} characterName
 * @param {{usedVoices?: Set<string>}} context
 * @returns {string} a voice id, always
 */
export function getSuggestedVoiceForCharacter(characterName, context = {}) {
  const raw = (characterName || '').toUpperCase().trim();
  const used = context.usedVoices || new Set();

  if (isNarratorName(raw)) return DEFAULT_NARRATOR_VOICE_ID;

  const tokens = raw.split(/[^A-Z0-9]+/).filter(Boolean);
  const isFemale = FEMALE_KEYWORDS.some(kw => tokens.includes(kw));

  // 1. Intent: first unused entry from the role shortlist.
  for (const id of pickShortlist(tokens, isFemale)) {
    if (!used.has(id)) return id;
  }

  // 2. Best unused castable voice of the right sex. VOICE_CATALOG is sorted by
  //    grade, so "first unused" is "best unused".
  const pool = CASTABLE_VOICES.filter(v =>
    v.sex === (isFemale ? 'Female' : 'Male') && v.id !== DEFAULT_NARRATOR_VOICE_ID
  );
  const unused = pool.find(v => !used.has(v.id));
  if (unused) return unused.id;

  // 3. The pool is exhausted. Reuse a good voice rather than introduce a bad one:
  //    two characters sharing a C+ voice at different pitch and pan is far more
  //    listenable than one character sounding like a broken vocoder. There are
  //    only five castable male voices, so a script with six or more male speakers
  //    reaches this every time — it is a normal outcome, not an error.
  if (pool.length > 0) return pool[stableHash(raw) % pool.length].id;

  return isFemale ? DEFAULT_VOICE_ID : 'am_fenrir';
}

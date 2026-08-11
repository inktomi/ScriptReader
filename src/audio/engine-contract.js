/**
 * The contract every synthesis engine satisfies.
 *
 * `ScreenplayAudioManager` drives synthesis through exactly this surface, so an
 * engine can be swapped without the scheduler, the lookahead loop, or the
 * teleprompter knowing anything changed. The scheduling half of this app —
 * anchors, cluster atomicity, the monotonic timeline edge — is entirely
 * engine-agnostic and stays that way.
 *
 * An engine renders; it never plays. Playback belongs to `PlaybackScheduler`,
 * which is why `gain`, `filter`, and `pan` are absent from everything here:
 * those are applied to the Web Audio graph after synthesis and work identically
 * whichever engine produced the buffer.
 */

export const ENGINE_IDS = {
  KOKORO: 'kokoro',
  OPENAI: 'openai:gpt-4o-mini-tts',
  WEB_SPEECH: 'web_speech'
};

/**
 * @typedef {Object} EngineCapabilities
 * @property {string}  id      Goes into every cache key, so two engines can never
 *                             collide on one. Carries the model where a provider
 *                             has several (`openai:gpt-4o-mini-tts`), so swapping
 *                             models invalidates cleanly instead of silently
 *                             serving renders from the old one.
 * @property {string}  label   Shown in the engine picker.
 * @property {boolean} supportsSpeed
 *   True when the engine has a tempo control that preserves pitch. The director
 *   uses this to decide whether it may play the tempo/pitch cancellation trick
 *   or must express tempo in words instead.
 * @property {boolean} supportsInstructions
 *   True when the engine accepts free-text direction. When set, emotion is handed
 *   to the model as a stage direction rather than synthesised out of pitch and
 *   speed arithmetic.
 * @property {boolean} isLocal   Nothing leaves the device.
 * @property {boolean} metered   Renders cost money. Gates spend caps, the
 *                               re-render confirmation, and seek debouncing.
 * @property {number}  nativeSampleRate
 * @property {number}  maxChunkChars
 *   How far the director may let one request run. Small for Kokoro so playback
 *   can start early; large for instruction engines, which re-interpret the
 *   direction per request and so give a long speech independently-invented
 *   prosody at every seam.
 * @property {number}  concurrency  How many renders may be in flight at once.
 * @property {'webspeech'|'error'} onUnavailable
 *   What `play()` does when the engine will not start. Falling back to the
 *   browser's built-in voice is right for a failed local download and wrong for
 *   a missing API key — silently dropping someone who chose paid cloud voices
 *   onto the robotic fallback hides the one thing they need to be told.
 */

/**
 * The interface. Documented rather than enforced — this is a plain-JS codebase,
 * and a base class here would buy inheritance rather than clarity.
 *
 * @typedef {Object} SynthesisEngine
 * @property {EngineCapabilities} capabilities
 * @property {boolean} isReady
 * @property {boolean} isLoading
 * @property {'idle'|'loading'|'ready'|'error'} phase
 * @property {(options?: object) => Promise<void>} init
 * @property {(key: string) => AudioBuffer|null} getCached
 * @property {(key: string) => boolean} has
 * @property {(key: string) => boolean} isPending
 * @property {(unit: object, priority?: number) => Promise<AudioBuffer>|null} request
 * @property {(keepKeys: string[]) => void} dropPendingExcept
 * @property {() => void} clearCache
 * @property {(cb: Function) => Function} onProgress  Returns an unsubscribe.
 * @property {(voiceProfile: object) => string} resolveVoiceId
 */

/**
 * FNV-1a, 32-bit.
 *
 * `Math.imul` is not optional: a plain `*` overflows into float arithmetic and
 * the hash stops being stable, which would quietly break every persisted cache
 * entry across a reload.
 */
export function hash32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The cache key for one render unit.
 *
 * Engine id is present because two engines' voice-id spaces are not disjoint and
 * nothing enforces that they are. The instruction hash is present because
 * without it the same voice saying the same words whispered and shouted collide
 * on one key — whichever rendered first would win for both, and the listener
 * would hear a shout where the script says whisper.
 *
 * Instructions are hashed rather than inlined: they run to several hundred
 * characters and repeat across every unit of every line a character speaks, so
 * inlining would multiply key memory for no extra discrimination.
 */
export function makeCacheKey({ engineId, voiceId, synthSpeed, instructions, text }) {
  const instr = instructions ? `#${hash32(instructions)}` : '';
  return `${engineId}|${voiceId}|${Number(synthSpeed).toFixed(3)}${instr}|${text}`;
}

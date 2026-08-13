/**
 * Shared cues — one cue, two speakers.
 *
 *                       CICI AND MAYA
 *                  Holy shit.
 *
 * That is not a character called "CICI AND MAYA". It is Cici and Maya saying the
 * same thing at the same moment, and both parsers take it literally: the cast
 * list gains a third person with her own voice card and her own line count.
 *
 * The app already knows how to play two people at once — `overlap.simultaneous`
 * is what Fountain's `^` and the PDF's side-by-side columns produce, and the
 * teleprompter, the performance director and the scheduler all read it. A joint
 * cue is simply the third way a script writes the same thing, so this pass
 * rewrites it into the representation that already works rather than teaching
 * anything downstream a new one.
 *
 * ## Why a post-pass, and why it runs before `annotateScriptFlow`
 *
 * Deciding that `CICI AND MAYA` means two people requires knowing that CICI and
 * MAYA each speak alone elsewhere — a fact about the whole script that neither
 * parser has while it is still reading line by line. Running afterwards, over the
 * finished cast list, it is one lookup.
 *
 * It has to run *before* `annotateScriptFlow`, because the halves it produces are
 * a relationship between adjacent elements, and that is the pass whose whole job
 * is to resolve those: a later interruption has to cut off both speakers, not
 * just whichever one happens to be written second.
 *
 * ## The safety rule
 *
 * A name is only split when every part of it already speaks alone somewhere in
 * this script. `GUARD ONE AND GUARD TWO`, where neither half ever has a solo cue,
 * stays exactly as written — the script gives no evidence those are two people
 * rather than one oddly-named one, and inventing cast members is worse than
 * leaving a joint one to be cast as a unit.
 */

/**
 * The separators a writer uses between two names on one cue. `\bAND\b` is
 * word-bounded on purpose: COMMANDER and ALEXANDER contain the letters but not
 * the word.
 */
const CUE_CONNECTOR_REGEX = /\s*(?:,|&|\+|\/|\bAND\b)\s*/i;

/** Past four, it is a crowd direction rather than a cue. */
const MAX_SHARED_SPEAKERS = 4;

/** Cue extensions — `(O.S.)`, `(CONT'D)` — belong to each speaker, not the pair. */
const CUE_EXTENSION_REGEX = /\([^)]*\)/g;

/** The distinct names in a cue, in the order the writer put them. */
function splitJointName(name) {
  const parts = [];
  for (const raw of String(name || '').split(CUE_CONNECTOR_REGEX)) {
    const part = raw.trim();
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts;
}

/**
 * Rewrite every joint cue into one dialogue element per speaker, related by
 * `overlap.simultaneous`.
 *
 * A no-op — returning the same object untouched — when the script has no joint
 * cue, which is almost every script.
 *
 * @param {Object} parsed the object a parser is about to return; mutated and returned
 * @returns {Object} the same object
 */
export function expandSharedDialogueCues(parsed) {
  const elements = parsed && parsed.elements;
  const characters = parsed && parsed.characters;
  if (!Array.isArray(elements) || !Array.isArray(characters)) return parsed;

  // Everyone the script cues on their own. This set is the entire safety net.
  const soloNames = new Map();
  for (const character of characters) {
    const name = typeof character?.name === 'string' ? character.name.trim() : '';
    if (name && splitJointName(name).length === 1) soloNames.set(name.toUpperCase(), name);
  }

  const expansions = new Map();
  for (const character of characters) {
    const name = typeof character?.name === 'string' ? character.name.trim() : '';
    if (!name) continue;
    const parts = splitJointName(name);
    if (parts.length < 2 || parts.length > MAX_SHARED_SPEAKERS) continue;
    if (!parts.every(part => soloNames.has(part.toUpperCase()))) continue;
    expansions.set(character.name, parts.map(part => soloNames.get(part.toUpperCase())));
  }

  if (expansions.size === 0) return parsed;

  const rebuilt = [];
  const remappedIndex = new Map();
  let previousJointName = null;
  let fragmentIndex = 0;

  elements.forEach((element, index) => {
    remappedIndex.set(index, rebuilt.length);

    const parts = element && element.type === 'DIALOGUE' ? expansions.get(element.character) : null;
    if (!parts) {
      previousJointName = null;
      rebuilt.push(element);
      return;
    }

    // One cue can produce several elements, because a direction part-way through
    // splits the speech. Only the first fragment *starts* the shared utterance;
    // the rest continue it — the same relation the Fountain parser gives a `^`
    // cue split the same way. Marking them matters: left blank, the second
    // fragment's first speaker follows the first fragment's second speaker over a
    // trailing dash, and `annotateScriptFlow` reads that as one half of the pair
    // interrupting the other half of the same line.
    fragmentIndex = element.character === previousJointName ? fragmentIndex + 1 : 0;
    previousJointName = element.character;

    const extensions = (element.characterOriginal || '').match(CUE_EXTENSION_REGEX);
    const suffix = extensions ? ` ${extensions.join(' ')}` : '';

    parts.forEach((name, part) => {
      rebuilt.push({
        ...element,
        character: name,
        characterOriginal: `${name}${suffix}`,
        // Cloned rather than shared: `annotateScriptFlow` re-reads the delivery of
        // a line that gets cut off, and one speaker's re-read must not arrive on
        // the other's element.
        nuance: element.nuance && typeof element.nuance === 'object'
          ? { ...element.nuance }
          : element.nuance,
        overlap: part > 0
          ? { mode: 'simultaneous', withPrevious: true, offsetMs: null, source: 'shared-cue' }
          : fragmentIndex > 0
            ? { mode: 'continuation', withPrevious: true, offsetMs: 0, source: 'shared-cue' }
            : element.overlap
      });
    });
  });

  // Both parsers emit ids that are also array positions, and the teleprompter,
  // the scene drawer and the scheduler all address elements by position.
  rebuilt.forEach((element, index) => { element.id = `line-${index}`; });

  // `scene.lineIndex` is an index into `elements` — it is how the scene drawer
  // jumps. Inserting elements moves every scene after the first shared cue.
  if (Array.isArray(parsed.scenes)) {
    for (const scene of parsed.scenes) {
      if (scene && remappedIndex.has(scene.lineIndex)) scene.lineIndex = remappedIndex.get(scene.lineIndex);
    }
  }

  const byName = new Map(characters.map(character => [character.name, character]));
  for (const [jointName, parts] of expansions) {
    const joint = byName.get(jointName);
    byName.delete(jointName);
    if (!joint) continue;
    for (const name of parts) {
      const target = byName.get(name);
      if (!target) continue;
      target.lineCount += joint.lineCount || 0;
      if (!target.sampleLine) target.sampleLine = joint.sampleLine;
    }
  }

  parsed.elements = rebuilt;
  // Re-sorted because auto-casting walks this list in order against a greedy set
  // of voices already handed out, so the order decides who gets which voice.
  parsed.characters = Array.from(byName.values()).sort((a, b) => b.lineCount - a.lineCount);
  parsed.totalLines = rebuilt.length;

  return parsed;
}

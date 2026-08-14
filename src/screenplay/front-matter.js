/**
 * Front matter — the cover page and anything else a PDF carries before the
 * screenplay itself starts.
 *
 *                          MIDNIGHT CARAVAN
 *
 *                             Written by
 *
 *                            Efrain Franco
 *
 *     effie85@gmail.com
 *     WGA #2227534
 *
 * The PDF cue detector is purely geometric — centred, upper case, short, with a
 * line of text under it — and a cover page is exactly that shape. So the title
 * becomes a speaker and the credit becomes its only line, and the writer's email
 * address becomes something the narrator reads aloud. Nothing downstream can
 * undo that, because by then it is indistinguishable from a real character.
 *
 * ## The boundary is the first body marker, and the cut is by page
 *
 * Everything on a cover page precedes the first slug line, so the marker is the
 * boundary. But the *cut* is made at a page edge, not at the marker itself: a
 * screenplay is allowed to open on `BLACK SCREEN.` or an epigraph before its
 * first slug, and dropping every line up to the marker would delete that. Pages
 * before the one the screenplay starts on cannot contain screenplay, so those
 * are the only ones dropped — which on a normal cover page is the same lines,
 * and on an unusual opening is none of them.
 *
 * A script with no cover page has its marker on page 1 and is left exactly as it
 * was, which is also why the synthetic single-page fixtures in the test suite are
 * unaffected by this pass.
 */

/** Where a scene starts. The first one is where the screenplay starts. */
const SLUG_LINE_REGEX = /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.|EST\.|INT\s|EXT\s)(\s+|$)/i;

/**
 * The other ways a screenplay opens, for scripts that open on something other
 * than a place. Deliberately generous: every extra entry can only make the drop
 * *shorter*, so a false match here costs nothing but a surviving cover page,
 * while a missing one would let real script get cut.
 */
const OPENING_REGEX =
  /^(FADE IN|FADE UP(\s+ON)?|COLD OPEN|TEASER|PROLOGUE|PROLOGUE:|ACT\s+(ONE|I|1)|SCENE\s+\d+)[:.]?$/i;

/**
 * A cover page, a blank verso and one more page of front matter is as much as a
 * screenplay plausibly carries. Beyond that the marker is more likely to be a
 * false negative than the front matter is to be real, and dropping pages on that
 * basis would be destroying script.
 */
const MAX_FRONT_MATTER_PAGES = 3;

/** Credits and registration numbers are not the title, however centred they are. */
const CREDIT_LINE_REGEX =
  /^(WRITTEN|SCREENPLAY|TELEPLAY|SCRIPT|STORY|ADAPTED|BASED|DIRECTED|PRODUCED|CREATED|DRAFT|REVISED|REVISION|FINAL|SHOOTING|PRODUCTION|COPYRIGHT|REGISTERED|WRITER|AUTHOR|WGA[WE]?|BY|AN?\s+ORIGINAL)\b/i;

/** An email address, a copyright mark or a phone number. */
const CONTACT_LINE_REGEX = /[@©]|\d{3}[-.\s]\d{3,4}|^\(?\d{3}\)?[-.\s]/;

function isBodyMarker(text) {
  return SLUG_LINE_REGEX.test(text) || OPENING_REGEX.test(text);
}

/**
 * Separate a PDF's front matter from its screenplay.
 *
 * @param {Array<{text: string, page?: number}>} lines extracted geometric lines
 * @returns {{frontMatter: Array, body: Array}} `frontMatter` is empty whenever
 *   the screenplay starts on the first page, or does not start at all.
 */
export function splitPdfFrontMatter(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return { frontMatter: [], body: lines || [] };

  const markerIndex = lines.findIndex((line) => isBodyMarker((line?.text || '').trim()));
  if (markerIndex <= 0) return { frontMatter: [], body: lines };

  const bodyPage = lines[markerIndex].page;
  if (!(bodyPage > 1) || bodyPage - 1 > MAX_FRONT_MATTER_PAGES) return { frontMatter: [], body: lines };

  const boundary = lines.findIndex((line) => line?.page >= bodyPage);
  if (boundary <= 0) return { frontMatter: [], body: lines };

  return { frontMatter: lines.slice(0, boundary), body: lines.slice(boundary) };
}

/**
 * The screenplay's own title, read off the cover page.
 *
 * Worth reading rather than falling back to the file name because a cover page
 * says `MIDNIGHT CARAVAN` where the file says `Midnight_Caravan`, and the title
 * is what names the script everywhere in the UI.
 *
 * @param {Array<{text: string, minX?: number, pageWidth?: number}>} frontMatter
 * @returns {string|null} null when the cover carries nothing usable.
 */
export function readTitlePageTitle(frontMatter) {
  if (!Array.isArray(frontMatter)) return null;

  for (const line of frontMatter) {
    const text = (line?.text || '')
      .trim()
      .replace(/^["“]+|["”]+$/g, '')
      .trim();
    if (text.length < 2 || text.length > 60) continue;
    if (!/\p{L}/u.test(text)) continue;
    if (text !== text.toUpperCase()) continue;
    if (CREDIT_LINE_REGEX.test(text) || CONTACT_LINE_REGEX.test(text)) continue;

    // The contact block sits at the action margin; the title is centred. Without
    // this a script whose cover leads with `WGA #2227534` would be titled after
    // its registration number.
    if (line.minX / (line.pageWidth || 612) < 0.2) continue;

    return text;
  }
  return null;
}

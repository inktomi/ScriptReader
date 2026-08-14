/**
 * HTML escaping for values that originate outside this codebase.
 *
 * Every screen in this app is built by assigning a template literal to
 * `innerHTML`, and much of what those templates interpolate comes from an
 * uploaded `.fountain` or `.pdf` — character cues, dialogue, scene headings,
 * titles. A character cue is whatever the writer typed, so a script containing
 *
 *     BOB<img src=x onerror=alert(1)>
 *
 * executes that markup in the page the moment the cast list renders. Escaping at
 * the interpolation site is what makes a script file data rather than code.
 *
 * This matters more than defacement: the app keeps cast configuration, playback
 * position, and an optional TTS API key on this origin, and injected script can
 * read all of them. localStorage, sessionStorage, and IndexedDB are equally
 * exposed — there is no storage location that survives script injection, so the
 * escaping is the control, not the storage choice.
 */

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a value for interpolation into HTML text content or into a
 * double-quoted attribute. Both contexts are covered by the same five
 * replacements, so callers never have to decide which one they are in.
 *
 * `&` is replaced first; doing it later would re-escape the ampersands
 * introduced by the other four and turn `<` into `&amp;lt;`.
 *
 * @param {*} value  Anything. Non-strings are stringified; null and undefined
 *                   become '' rather than the strings "null"/"undefined",
 *                   because these are interpolated into user-facing markup
 *                   where a missing value should read as absent, not as a word.
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

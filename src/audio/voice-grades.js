/**
 * Upstream per-voice quality grades for Kokoro.
 *
 * These are hexgrad's own grades, taken verbatim from the frozen VOICES table in
 * `kokoro-js@1.2.1` (`dist/kokoro.web.js`). The package does not export that
 * table — at runtime it is only reachable as `tts.voices`, inside the worker,
 * after the model has finished loading — so it is mirrored here as data. After a
 * `kokoro-js` bump, re-verify with `console.table(tts.voices)` in the worker.
 *
 * Nothing in this file is a judgement call, and that is the entire point. The
 * decorative "S-Tier Neural" / "A-Tier Neural" strings this replaces had drifted
 * until they were inverted from reality — `af_river` was labelled A-Tier while
 * grading D, and `am_adam`, the worst voice in the set, was labelled S-Tier and
 * used as the fallback in nine places.
 *
 * `targetQuality` (the grade the training run aimed at) is omitted; only
 * `overallGrade` describes what a listener actually hears.
 */
export const KOKORO_GRADES = Object.freeze({
  af_heart: 'A',
  af_bella: 'A-',
  af_nicole: 'B-',
  bf_emma: 'B-',
  af_aoede: 'C+',
  af_kore: 'C+',
  af_sarah: 'C+',
  am_fenrir: 'C+',
  am_michael: 'C+',
  am_puck: 'C+',
  af_alloy: 'C',
  af_nova: 'C',
  bf_isabella: 'C',
  bm_george: 'C',
  bm_fable: 'C',
  af_sky: 'C-',
  bm_lewis: 'D+',
  af_jessica: 'D',
  af_river: 'D',
  am_echo: 'D',
  am_eric: 'D',
  am_liam: 'D',
  am_onyx: 'D',
  bf_alice: 'D',
  bf_lily: 'D',
  bm_daniel: 'D',
  am_santa: 'D-',
  am_adam: 'F+'
});

const SCORE = Object.freeze({
  'A+': 12, 'A': 11, 'A-': 10,
  'B+': 9, 'B': 8, 'B-': 7,
  'C+': 6, 'C': 5, 'C-': 4,
  'D+': 3, 'D': 2, 'D-': 1,
  'F+': 0, 'F': -1
});

/** Numeric rank for sorting and thresholds. Unknown ids sort last. */
export function gradeScore(voiceId) {
  const grade = KOKORO_GRADES[voiceId];
  return grade === undefined ? -2 : SCORE[grade];
}

/**
 * The quality floor for automatic casting.
 *
 * At or above this, a voice may be assigned without anyone asking for it. Below
 * it, a human has to choose it on purpose — those voices stay selectable, because
 * `am_onyx` (D) is the only deep menacing bass in the set and a user may
 * reasonably trade fidelity for character. The rule is inform, don't decide.
 */
export const CASTABLE_SCORE = SCORE['C'];

export function isCastable(voiceId) {
  return gradeScore(voiceId) >= CASTABLE_SCORE;
}

/**
 * Human-readable label, *derived* from the grade rather than stored next to it.
 * A label that cannot be edited independently of its grade cannot drift out of
 * agreement with it — which is exactly how the previous labels became wrong.
 */
export function gradeLabel(voiceId) {
  const score = gradeScore(voiceId);
  if (score >= 10) return 'Reference';
  if (score >= 7) return 'Excellent';
  if (score >= 6) return 'Good';
  if (score >= 4) return 'Fair';
  if (score >= 1) return 'Rough';
  return 'Poor';
}

/** Accent colour matching the label bands, for badges in the casting UI. */
export function gradeColor(voiceId) {
  const score = gradeScore(voiceId);
  if (score >= 7) return '#10B981';
  if (score >= 5) return '#06B6D4';
  if (score >= 3) return '#F59E0B';
  return '#F87171';
}

/** Sort comparator: best first, stable within a grade. */
export function byGradeDesc(a, b) {
  return gradeScore(b.id) - gradeScore(a.id);
}

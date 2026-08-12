# ScriptReader Engineering Guidelines

These instructions apply to the entire repository.

## Preserve user state across UI updates

- Prefer targeted DOM updates over replacing a complete interactive view.
- If a render replaces DOM nodes, preserve and restore the active control, text value and selection, scroll position, and any relevant playback state.
- Keep keyboard focus inside modal dialogs through loading, success, error, retry, pagination, and nested-modal transitions.
- When a focused control becomes disabled or disappears, move focus to the nearest useful replacement rather than allowing it to fall back to the document body.
- Add a keyboard-focused regression test whenever changing modal rendering or interaction state.

## Make asynchronous ownership explicit

- Every asynchronous UI workflow must have a clear owner and cancellation lifetime.
- Abort work when its owning view closes or when a newer operation supersedes it.
- Pair cancellation with a request identity, generation counter, or equivalent stale-result check; cancellation alone does not prevent late results from committing.
- Keep search, pagination, preview, import, and retry state independent so one operation cannot accidentally cancel or mutate another.
- After an irreversible commit, finish the required reconciliation even if the initiating UI has closed.
- Test important event orderings, including close-during-operation, rapid replacement, stale completion, retry, and overlapping requests.

## Bound remote data and resource use

- Treat remote APIs as large, incomplete, duplicated, and potentially malformed datasets.
- Stream downloads and enforce byte limits while reading. Do not rely only on `Content-Length` and do not buffer an unbounded response before validating its size.
- Put explicit limits and eviction policies on rendered results, caches, object URLs, audio elements, and other retained resources.
- Revoke object URLs, stop playback, detach handlers, and release readers when work is replaced or abandoned.
- Normalize and validate provider metadata at the boundary before it reaches casting, filtering, or persistence code.

## Keep catalog results honest and deterministic

- Apply quality ranking across every fetched category and page, not independently within a single response.
- Deduplicate provider results by stable source identity before ranking or displaying them.
- A language filter must select matching language-specific preview and accent metadata when available.
- Labels and result counts must describe what the UI actually ranked or displayed; do not imply a global optimum when only a bounded subset is available.
- Preserve stable local identifiers when refreshing or replacing a voice so existing casting assignments remain valid.

## Protect multi-store persistence

- Treat IndexedDB sample data and localStorage metadata as one logical write even though the browser cannot transact across both.
- Define commit order and compensating rollback before implementing a multi-store mutation.
- Never delete the last usable sample or assignment until its replacement is durably available.
- On failure, remove newly created orphan data without deleting a previously valid replacement target.
- Verify persisted metadata against the backing sample store before presenting an item as available.
- Add regression tests for partial writes, replacement, abort, stale metadata, and rollback.

## Verification expectations

- Every defect fix must include a regression test that reproduces the failing ordering or boundary where practical.
- For feature changes, run the focused tests first, then the complete test suite and production build.
- Before handoff, run `git diff --check` and inspect the complete pending diff, including untracked files.
- Review cross-layer features as a system: provider API, normalization, UI lifecycle, audio resources, persistence, and existing assignments can fail at their boundaries even when each happy path works independently.

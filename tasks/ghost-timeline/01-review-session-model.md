# Ghost timeline review session model

Status: complete

## Goal

Turn the existing timeline-diff helpers into a small review-session seam that
keeps accepted timeline state, reviewable proposals, selection, and proposal
preview state distinct. The browser UI should consume this seam instead of
reimplementing pending-diff ordering and preview derivation in `main.js`.

## Dependencies

- The completed `tasks/timeline/01-*` and `02-*` implementation.
- `src/timeline-diff-review.js` and `src/timeline-diffs.js`.
- The persisted `timelineDiffs` collection in `src/project-store.js`.

## Design

Add a focused review-session module or extend the existing review module with
pure operations for:

- listing reviewable diffs in deterministic creation order;
- flattening a diff into selectable ghost items with stable keys;
- selecting the first, previous, and next review item;
- entering and leaving preview mode for one proposal; and
- deriving preview clips without mutating accepted clips.

The session must distinguish a diff from an operation within that diff. A
move's origin and destination remain separate visual items but share one
review action. Previewing a proposal must be an explicit state transition;
normal playback must continue to use accepted clips.

Keep the public API small and clone values at the boundary so callers cannot
mutate project state through a returned review item. Preserve operation type,
diff status, provenance, and before/after clip snapshots.

## Acceptance criteria

- Reviewable ordering is stable across reloads and independent of object
  insertion order.
- First/previous/next selection handles empty, single-item, and multi-item
  review queues without throwing.
- Previewing a diff returns a derived clip list and never changes accepted
  clips or persisted project JSON.
- Exiting preview restores accepted playback state.
- Unit tests cover add, move, trim, replace, remove, stale, and multi-operation
  proposals.
- Existing timeline and regeneration tests remain green.

## Non-goals

- No new FAL calls or model selection.
- No automatic acceptance or rejection.
- No redesign of the timeline's visual styling.

# Ghost proposal preview and navigation UI

Status: complete

## Goal

Make the review loop obvious in the browser. A user should be able to move
through pending ghost changes, preview one proposed edit, and return to the
accepted cut without ambiguity.

## Dependencies

- `01-review-session-model.md`.
- Existing ghost rendering and inspector controls from
  `tasks/timeline/02-ghost-timeline-review-ui.md`.
- Existing accepted-versus-proposal player state in `src/main.js`.

## UI

- Add explicit previous/next review controls near the pending-diff badge.
- Show the current review position, for example `2 of 5`, when a review queue
  exists.
- Add `Preview proposal` and `Exit preview` controls with mutually exclusive
  labels and disabled states.
- Keep the accepted timeline clips visually distinct from ghost clips while a
  proposal is being previewed.
- Keep the player status explicit: `Accepted preview` or `Proposal preview`.
- After accept, reject, or revised-drag actions, select the next available
  review item rather than leaving a stale ghost selection behind.

## Interaction rules

Preview mode changes only the derived player view and playhead focus. It must
not make proposal clips draggable as accepted clips, mutate accepted clips, or
silently accept a proposal when playback reaches its end.

Keyboard focus must remain visible. Enter/Space on a focused ghost selects it;
the navigation controls must be reachable by keyboard and expose useful
accessible names. Escape exits proposal preview before it closes any future
modal layered over the editor.

## Acceptance criteria

- A browser test can create at least two pending proposals and navigate them
  forward and backward.
- Previewing a proposal changes the player label and active clip source, while
  accepted playback remains unchanged after exiting preview.
- Accepting or rejecting the selected proposal advances selection safely.
- The queue controls disappear when there are no reviewable proposals.
- Browser smoke coverage reports no console errors or page errors during
  navigation, preview, accept, reject, and exit-preview actions.

## Non-goals

- No multi-user collaboration.
- No final render or export behavior.
- No new generation provider integration.

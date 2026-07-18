# Ghost timeline review UI

Status: planned

## Goal

Make pending timeline diffs visible and reviewable without changing the
accepted edit. Ghost clips should communicate what will happen before the
user commits the proposal.

## Dependencies

- `01-timeline-diff-model.md`.
- Existing timeline rendering, selection, drag, and inspector modules.

## UI

- Render pending additions and replacements as semi-transparent ghost clips.
- Render proposed moves as an outline at the destination and a faded marker at
  the original location.
- Render proposed removals as struck-through or red-tinted clips.
- Show a diff badge and summary in the timeline toolbar.
- Add per-diff `Accept` and `Reject` controls in the inspector.
- Add `Accept all` and `Reject all` only when multiple pending diffs exist.

## Design

The UI reads proposals through the diff module interface. It must not mutate
the accepted `clips` collection while rendering or selecting a ghost clip.
Selecting a ghost should show both before and after provenance, including
prompt, model, seed, parameters, parent asset, and character versions.

Keyboard and pointer interactions must distinguish accepted clips from ghost
clips. Dragging a ghost creates a revised proposal rather than moving the
accepted clip.

## Acceptance criteria

- A pending add, move, replace, trim, and remove is visually distinguishable.
- Selecting a ghost shows a reviewable before/after inspector state.
- Accepting one diff updates the timeline and removes only that ghost.
- Rejecting one diff leaves accepted playback unchanged.
- The playhead and player preview use accepted clips unless a preview action
  explicitly asks to inspect the proposal.
- Browser smoke coverage verifies no console errors during review actions.

## Non-goals

- No generation request implementation.
- No collaborative review or multi-user conflict handling.
- No final render/export changes.

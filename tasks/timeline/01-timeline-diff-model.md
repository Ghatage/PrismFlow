# Timeline diff model and persistence

Status: planned

## Goal

Create the reviewable change model that makes agent editing safe. Proposed
timeline changes must remain separate from the accepted edit until the user
accepts them.

## Dependencies

- Persisted project JSON and provenance.
- Character version references from `tasks/characters/04-*`.

## Design

Add a versioned `timelineDiffs` collection to the project model. A diff is a
set of operations against one accepted timeline revision.

```js
{
  id,
  baseRevision,
  status: "pending" | "accepted" | "rejected" | "stale",
  source: "agent" | "generation" | "user",
  summary,
  operations: [{
    type: "add" | "move" | "trim" | "replace" | "remove",
    clipId,
    proposedClip,
    before,
    after
  }],
  provenance,
  createdAt,
  updatedAt
}
```

The diff module should expose a small interface: create a proposal, list
pending proposals, accept one, reject one, and mark stale proposals. The
implementation owns validation, revision checks, and persistence so callers
do not duplicate timeline mutation rules.

## Invariants

- Creating a diff never mutates accepted clips.
- Accepting applies all operations atomically or applies none.
- Rejecting removes only the proposal, not referenced assets or characters.
- A proposal based on an old revision cannot silently overwrite newer edits.
- Provenance and `characterVersionIds` survive every operation.

## Acceptance criteria

- Add, move, trim, replace, and remove operations can be represented.
- Pending diffs survive reload.
- Accepting a diff updates the accepted timeline and revision exactly once.
- Rejecting a diff leaves the accepted timeline byte-for-byte equivalent.
- Stale proposals are visible and cannot be accepted without reconciliation.
- Store tests cover malformed diffs and repeated accept/reject calls.

## Non-goals

- No ghost-clip rendering yet.
- No FAL job submission.
- No chat or agent pane.

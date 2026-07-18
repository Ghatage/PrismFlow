# Stale ghost proposal reconciliation

Status: planned

## Goal

Give users a safe path for proposals that were created against an older
accepted timeline revision. Stale proposals must be recoverable when their
targets are still compatible, but must never overwrite newer user edits.

## Dependencies

- `01-review-session-model.md`.
- The revision and stale-marking rules in `src/project-store.js`.
- Existing accept/reject operations exposed by `src/timeline-diffs.js`.

## Design

Add a domain operation for rebasing a stale proposal onto the current accepted
revision. Rebase should create a new pending proposal with a new ID and
`baseRevision` equal to the current revision, preserve the original proposal
in review history, and record `reconciliation.rebasedFromDiffId` in
provenance. Do not edit the old stale proposal in place.

Rebase rules must be conservative:

- `add` operations can rebase when their generated asset still exists and the
  proposed clip ID is unused.
- `move` and `trim` can rebase only when the target clip still exists and its
  immutable identity and asset match the original `before` snapshot.
- `replace` can rebase only when the source clip still exists with the same
  identity and source asset.
- `remove` can rebase only when the target clip still exists with the same
  identity and source asset.

If any operation conflicts, return a structured conflict list and leave the
stale proposal unchanged. The UI should offer `Rebase proposal` for safe
proposals and a clear conflict explanation plus `Reject` for conflicted ones.

## Acceptance criteria

- Rebased proposals are pending at the current revision and can be accepted
  exactly once.
- The original stale proposal remains persisted and linked as history.
- Asset deletion, clip replacement, and concurrent movement produce explicit
  conflicts without changing accepted clips.
- Rebase is idempotent and cannot create duplicate pending proposals for the
  same source revision and diff.
- Browser coverage verifies a stale proposal can be inspected, rebased when
  compatible, and rejected when incompatible.

## Non-goals

- No automatic conflict merging for overlapping user edits.
- No collaborative locking or server-side persistence.
- No silent fallback to accepting a stale proposal.

# Land generation results as pending timeline diffs

Status: planned

## Goal

Connect asynchronous FAL results to the review loop. A completed generation
must arrive as a pending timeline proposal, never as an automatic timeline
mutation.

## Dependencies

- `01-timeline-diff-model.md`.
- `02-ghost-timeline-review-ui.md`.
- Existing FAL and character-generation adapters.

## Design

Create a generation-result normalizer at the FAL adapter seam. It converts
provider output into an asset record plus a diff operation.

```js
normalizeGenerationResult({ job, output, sourceClip, project }) -> {
  asset,
  diff: {
    source: "generation",
    operations: [{ type: "add" | "replace", ... }],
    provenance
  }
}
```

The provenance must include prompt, model ID, seed, parameters, parent asset
IDs, and locked `characterVersionIds`. If a job fails, the job remains visible
as failed and creates no diff.

## Flow

```text
submit → queued → running → completed → asset + pending diff
                         ↘ failed → retry
```

The user can continue editing while jobs run. A completed result is shown in
the ghost timeline and can be accepted or rejected using the review UI.

## Acceptance criteria

- Fake queue tests cover queued, running, completed, failed, and retry states.
- A completed output creates a pending add or replace diff only once.
- Replayed completion events are idempotent and do not duplicate clips.
- FAL failures never create an accepted clip or orphaned diff.
- Character references are carried into the generated clip provenance.
- Accepting the diff makes the generated asset playable in the preview.
- No paid generation is required for deterministic tests.

## Non-goals

- No speculative generation.
- No credits meter or draft/final quality tiers.
- No automatic acceptance of generated results.

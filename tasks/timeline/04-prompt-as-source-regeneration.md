# Prompt-as-source clip regeneration

Status: planned

## Goal

Treat generated clips as cached evaluations of their prompts. Users should be
able to edit the source prompt, reroll a seed, switch models, or compare
variants while every result remains reviewable as a timeline diff.

## Dependencies

- `01-timeline-diff-model.md` through `03-generation-results-as-diffs.md`.
- Persisted clip provenance and character version references.

## UI

- Add `Edit prompt` to the selected generated clip inspector/context menu.
- Show prompt, model, seed, parameters, parent asset, and character references.
- Provide `Reroll seed`, `Same prompt, different model`, and `Compare variants`.
- Show generated variants in a comparison panel with one `Use this version`
  action per candidate.
- Choosing a candidate creates a pending replacement diff; it never overwrites
  the accepted clip immediately.

## Design

Use a small regeneration interface:

```js
regenerateClip({
  clipId,
  prompt,
  modelId,
  seed,
  params,
  characterVersionIds
}) -> { jobId }
```

The implementation should derive the request from persisted provenance and
return a normalized generation job. It should preserve the original clip as
the parent asset and record the changed fields in the proposed replacement's
provenance.

## Invariants

- Original prompt and output remain recoverable after every reroll.
- A locked character version cannot be silently replaced by another version.
- Comparing variants does not add every candidate to the timeline.
- Selecting a candidate creates exactly one pending replacement diff.
- Accepted timeline state changes only through diff acceptance.

## Acceptance criteria

- Prompt edits, seed rerolls, and model changes produce distinct jobs.
- A comparison panel can show at least two deterministic fake candidates.
- Candidate selection creates a replacement diff with complete provenance.
- Rejecting the candidate leaves the original clip and prompt intact.
- Accepting the diff updates the clip while preserving its parent asset history.
- Character references remain attached to every generated variant.

## Non-goals

- No semantic project search yet.
- No automatic agent planning.
- No final-quality regeneration or upscaling policy.

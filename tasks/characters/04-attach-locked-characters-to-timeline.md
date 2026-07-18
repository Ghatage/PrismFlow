# Attach locked character versions to timeline clips

Status: implemented

## Goal

Make locked characters useful to the editing and generation workflow. A clip
can reference one or more exact character versions, and future generation
requests include those references without copying character implementation
details into timeline UI code.

## Dependencies

- All three preceding character plans.
- Persisted clips and provenance.
- The timeline inspector and future generation-request seam.

## Design

Add `characterVersionIds: []` to clip provenance. Use version IDs rather than
only character IDs so an old shot remains reproducible after a character is
regenerated.

The timeline module should expose a small operation for attaching or removing
character versions. A separate request-builder module resolves those IDs into
reference asset IDs for a generation adapter.

```js
clip.provenance.characterVersionIds = ["char-fox-v2"]

buildGenerationRequest({ clip, project }) -> {
  prompt,
  referenceAssetIds,
  provenance
}
```

## UI

- Add a `Characters` section to the selected-clip inspector.
- Show attached characters as chips with their lock/version state.
- Offer `Add character` from the locked character library.
- Allow removal from the clip without deleting the character.
- Show which locked version will be used by a future generation.

## Acceptance criteria

- A clip can attach multiple locked character versions.
- Removing a character from a clip leaves the character library unchanged.
- Regenerating a character creates a new version and does not rewrite old clips.
- Generation request construction includes the correct reference asset IDs.
- The attached references survive reload and remain visible in the inspector.
- Existing playback and timeline editing remain unchanged.

## Non-goals

- No automatic character detection in media.
- No multi-shot consistency scoring.
- No timeline diff acceptance UI beyond preserving the provenance seam.

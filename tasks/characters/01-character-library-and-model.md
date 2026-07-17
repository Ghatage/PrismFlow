# Character library and versioned character model

Status: implemented

## Goal

Create the first-class character library described in feature 4. A character is a reusable reference identity, not a timeline clip. Each character has immutable generated versions, and locking pins one exact version for future generations.

## Dependencies

- The persisted project JSON and provenance store.
- Existing Media/Characters left-panel structure.

## Design

Add a `characters` collection to the project model. Keep binary images and blob URLs in the asset store; persist only stable asset IDs and metadata.

```js
{
  id,
  name,
  status: "draft" | "ready" | "failed",
  lockedVersionId: null | versionId,
  activeVersionId,
  versions: [{
    id,
    sheetAssetId,
    referenceAssetIds: [],
    prompt,
    modelId,
    seed,
    params,
    parentAssetIds: [],
    createdAt
  }]
}
```

The character-library module should expose a small interface: load the
collection, create a draft, record a version, and lock or unlock a version.
The UI should not know how the project store serializes the collection.

## UI

- Turn the existing Media area into `Media` and `Characters` tabs.
- Show a `+` card with the same dimensions as a character card.
- Show the active character sheet, name, and lock state on each card.
- Clicking a card opens the character detail modal.
- A locked character displays the locked version and does not silently mutate.
- Regeneration creates a new version; it never overwrites a locked version.

## Acceptance criteria

- A character can be created, renamed, selected, locked, and unlocked.
- Multiple versions can exist without changing older timeline references.
- The project JSON survives reload with character metadata intact.
- No API key, blob URL, or base64 image data is persisted in the project JSON.
- Existing media import, timeline placement, and playback continue to work.

## Non-goals

- No FAL network request.
- No prompt composer implementation.
- No automatic attachment to timeline clips yet.

# Character composer and generation job states

Status: implemented

## Goal

Make the `+` card open a focused character composer and establish the UI state machine for creating a reference sheet. This commit uses a fake or local adapter so the UI can be verified without spending credits or depending on a remote model.

## Dependencies

- `01-character-library-and-model.md`.
- The existing FAL adapter status seam.

## Design

The composer owns form state and delegates generation through a small adapter
interface. The composer must not construct FAL request payloads directly.

```js
generateCharacterSheet({
  name,
  prompt,
  referenceAssetIds,
  styleNotes
}) -> { jobId }
```

Normalize all adapter outcomes into these UI states:

```text
idle → generating → ready
                 ↘ failed → retrying
```

## UI

- Modal fields: character name, visual prompt, style notes, and optional media references.
- Primary action: `Generate character sheet`.
- Disable duplicate submission while a job is generating.
- Show a generating card with progress/status text.
- Show failed state with the error and a retry action.
- On success, show the new sheet in the character detail modal with `Lock character` available.

## Acceptance criteria

- The composer validates a non-empty name and prompt.
- Fake generation can deterministically exercise ready and failed states.
- Closing and reopening the modal does not lose a completed version.
- Retry creates a new job state without duplicating the character.
- The new version is not locked unless the user explicitly locks it.

## Non-goals

- No real FAL request.
- No timeline attachment.
- No automatic prompt rewriting or multi-model comparison.

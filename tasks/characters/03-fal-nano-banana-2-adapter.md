# Connect character generation to FAL Nano Banana 2

Status: implemented

## Goal

Replace the fake character-generation adapter with a server-side FAL adapter for Nano Banana 2 while keeping the browser unaware of credentials and model-specific request details.

## Dependencies

- `01-character-library-and-model.md`.
- `02-character-composer-and-job-states.md`.
- The existing server-only FAL key handling in `server/fal-adapter.mjs`.

## Design

The browser calls a local server route. The server adapter owns authentication,
model ID, request normalization, queue polling, error normalization, and
result extraction. The UI receives only a stable job/result shape.

```js
submitCharacterSheet(input) -> { jobId }
getCharacterSheetJob(jobId) -> {
  status: "queued" | "running" | "completed" | "failed",
  asset: null | { url, mimeType, width, height }
}
```

The generated sheet becomes a versioned asset. If the provider returns a
single contact sheet, keep it as the canonical inspection asset and leave
optional cell-cropping as a later implementation detail.

## Acceptance criteria

- The browser never receives `FAL_API_KEY` or `FAL_KEY`.
- A composer submission creates a visible queued/running job.
- Completed output is recorded as a character version with prompt, model ID,
  seed, parameters, and source asset metadata.
- Remote errors become readable failed states with retry support.
- A fake adapter remains available for deterministic browser tests.
- No timeline mutation occurs when a generation completes.

## Non-goals

- No character-to-clip attachment.
- No final video rendering.
- No automatic locking after generation.

# PrismFlow browser editor

This is a clean-room browser editor prototype inspired by the workspace density of `remotion/`, but it does not import or execute Remotion. It is a small local app with its own media, clip, timeline, and playback model.

## Run locally

```bash
npm run dev
```

Then open [http://localhost:4173](http://localhost:4173).

The local server reads `.env` and keeps `FAL_API_KEY` server-side. Character generation uses the local `POST /api/characters/generate` and `GET /api/characters/jobs/:jobId` routes; the browser never receives credentials or constructs Nano Banana 2 payloads. The existing generic `POST /api/fal/run` seam remains available for other models:

```json
{
  "modelId": "fal-ai/your-model",
  "input": {}
}
```

## Current prototype loop

- Import video, audio, and image files through the asset bin or drop zone.
- Drag assets from the bin to the Video or Audio track.
- Drag clips to reposition them, select them to inspect timing, and remove them.
- Create versioned character sheets, explicitly lock an identity version, and attach locked versions to selected clips.
- Use Space or the player controls to preview the timeline.
- Adjust the timeline zoom and seek by clicking the ruler or lanes.

The editor now persists character versions and generation provenance while keeping final rendering as a separate future layer.

## Deterministic character testing

Open [http://localhost:4173/?characterAdapter=fake](http://localhost:4173/?characterAdapter=fake) to run the character composer without a FAL key or network request. Include `[fail]` in the visual prompt to exercise the failed and retrying states. The default route uses the server-side Nano Banana 2 queue adapter.

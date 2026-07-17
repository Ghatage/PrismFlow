# PrismFlow browser editor

This is a clean-room browser editor prototype inspired by the workspace density of `remotion/`, but it does not import or execute Remotion. It is a small local app with its own media, clip, timeline, and playback model.

## Run locally

```bash
npm run dev
```

Then open [http://localhost:4173](http://localhost:4173).

The local server reads `.env` and keeps `FAL_API_KEY` server-side. The browser only sees the adapter status. A generic `POST /api/fal/run` seam is available for wiring model generation later:

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
- Use Space or the player controls to preview the timeline.
- Adjust the timeline zoom and seek by clicking the ruler or lanes.

The editor intentionally stops before model selection, generation jobs, provenance persistence, and final rendering. Those are the next product layer around the isolated FAL adapter.

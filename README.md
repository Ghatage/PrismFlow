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

## Sync the FAL model directory and pricing

With the app open at `http://localhost:4173`, run this in that page's browser console:

```js
await import('/scripts/sync-model-pricing.mjs');
```

The server uses `FAL_API_KEY` to paginate through the active FAL model directory and batch pricing requests. The browser script stores one record per active endpoint in the persistent `modelPricing` IndexedDB object store; the API key is never sent to or stored in the browser.

## Semantic model search

Build the local vector index from `fal-model-pricing.json` once with:

```bash
npm run search:index
```

This embeds each model's display name, description, type, group, and tags with `Xenova/all-MiniLM-L6-v2`, stores the searchable text and vectors in the ignored `model-search-index.json`, and uses TinkerBird's HNSW index for retrieval.

The HTTP endpoint is:

```text
GET /api/search/models?q=Google%20latest%20text%20to%20image&limit=10
```

It returns model metadata, pricing, the derived API documentation URL, and ranking signals. `GET /api/search/models/status` reports whether the local index is ready; `POST /api/search/models/index` rebuilds it.

## Current prototype loop

- Import video, audio, and image files through the asset bin or drop zone.
- Drag assets from the bin to the Video or Audio track.
- Drag clips to reposition them, select them to inspect timing, and remove them. Cmd/Ctrl-click toggles selection and Shift-click selects a contiguous same-track range.
- Create versioned character sheets, explicitly lock an identity version, and attach locked versions to selected clips.
- Right-click selected image/video clips and choose `Apply Style` to generate review candidates without replacing accepted clips.
- Use Space or the player controls to preview the timeline.
- Adjust the timeline zoom and seek by clicking the ruler or lanes.

The editor now persists character versions and generation provenance while keeping final rendering as a separate future layer.

## Storyboard act workspaces

Click an act card to open its near-fullscreen beat workspace. Beats are editable graph nodes: use a link’s `+` to insert into that chain, a node’s output `+` to append a linked beat, or `+ Add beat` to create a standalone node. Deleting a beat removes its incident links without reconnecting the remaining nodes. `Save` commits the whole act atomically; closing a dirty act with X or Escape asks before discarding it.

Each beat can generate a hero still and an editable screenplay block. `@Character` references resolve to that character’s active or locked sheet version. The server combines those reference sheets with the target beat, the ordered story so far, narrative structure, and cinematic direction, then sends the still to `fal-ai/nano-banana-2/edit` (or the text-to-image endpoint when there are no character references). Screenplay generation runs through FAL’s OpenRouter endpoint with `google/gemini-2.5-flash` by default; override it with `PRISMFLOW_STORYBOARD_SCRIPT_MODEL`. Provider credentials and model routing remain server-side.

Use `?storyboardAdapter=fake` for deterministic local still, screenplay, and video-prompt generation. Generated beat screenplays are canonical: the editor’s Script panel reads and saves the same storyboard records.

The editor opens on the first act and shows that act’s saved beat stills in a horizontally scrollable linked strip below the player. Clicking a still opens the beat-video workspace: it displays the canonical screenplay beside the reference image, generates an editable time-coded prompt for a selected 4–15 second duration, and submits the prompt plus `@Image1` to `bytedance/seedance-2.0/reference-to-video`. Generated prompts cover the full duration with hard camera cuts no longer than three seconds, deliberately changing angle, shot size, focus, depth, or staging on every cut instead of holding one canonical AI camera setup. Every cut includes an explicit spoken line shorter than three seconds; a solo character speaks aloud to themself. Generated and edited prompts are stored on their canonical storyboard beats with the selected duration, so reopening a beat restores the exact prompt that was sent. Seedance native audio stays enabled for dialogue, ambience, and sound effects, while the browser and server both enforce explicit editing and no-music directions. The generated prompt keeps an internal clock beginning at 00:00, but the resulting clip is appended externally after the last clip on the active act’s target video track. After submission, the modal closes and a pulsing timeline clip reserves that appended span until the output lands.

## Apply Style

Apply Style runs up to three clip jobs concurrently and persists their queue state so unfinished work resumes after a refresh. Video clips are trimmed to their exact source range, then sent to `fal-ai/kling-video/o3/standard/video-to-video/edit`; image clips use `fal-ai/nano-banana-2/edit`. A style version can contribute up to four image references. The optional `PRISMFLOW_STYLE_VIDEO_MODEL`, `PRISMFLOW_STYLE_IMAGE_MODEL`, and `PRISMFLOW_STYLE_TRIM_MODEL` environment variables override those server-side endpoints.

Each completed result is added to Imports and proposed in a stacked ghost rail above the accepted clip. Accept replaces the clip through the existing diff review contract; reject removes only the proposal and preserves the generated import. Video clips outside Kling O3 Edit's 3–15 second range are shown as unsupported while other selected clips can continue.

## Local video frame annotations and semantic search

Video imports are sampled from the first frame and then every five seconds. The JPEG snapshots and their annotation manifests live in the persistent IndexedDB `videoFrames` and `videoFrameManifests` stores, tagged with the source video asset ID and source time. Incomplete indexing resumes after a refresh.

The server annotates each snapshot with the local Transformers.js `Xenova/moondream2` model, downloaded once with:

```bash
npm run video:model
```

The default model can be changed with `PRISMFLOW_VIDEO_VLM_MODEL`. Annotated frame records are embedded with the existing TinyLM embedder and stored in a TinkerBird HNSW index at the ignored `video-search-index.json` file. Search is available at:

```text
GET /api/search/video?q=fox%20near%20water&limit=10
```

The editor’s top search bar and Agent pane query this endpoint alongside project context. Clicking a frame hit selects the source asset, seeks to the matching timeline position when that asset is on the timeline, and highlights the matching media card and clip.

## Ghost timeline review contract

- Accepted clips remain the playback source until `Preview proposal` is explicitly entered; `Exit preview` or Escape returns to accepted playback.
- Pending and stale proposals are ordered by creation time and exposed as keyboard-selectable ghost buttons. A move renders origin and destination ghosts but remains one review action.
- Accept and reject advance to the next available proposal. Stale proposals must be rebased conservatively or rejected; a rebase preserves the stale record and creates a new pending history record.
- Review regression tests use deterministic fixtures and the fake generation adapter, so they do not make paid provider requests.

## Deterministic character testing

Open [http://localhost:4173/?characterAdapter=fake](http://localhost:4173/?characterAdapter=fake) to run the character composer without a FAL key or network request. Include `[fail]` in the visual prompt to exercise the failed and retrying states. The default route uses the server-side Nano Banana 2 queue adapter.

# Multi-project hub + splash dock animation (2026-07-18)

- [x] `src/browser-database.js`: DB v4 — one record per project keyed by `project.project.id`; migrate legacy `'current'` record; add `listProjects()`, `deleteProject(id)`; `loadProject(projectId)`; `saveProject` keys by payload id.
- [x] `src/projects-hub.js` (new): `summarizeProject(project)` + `renderProjectsHub(app, {summaries, onOpen, onCreate, onDelete})` — big "+" tile first, then project tiles (name, counts, updated date, delete).
- [x] `src/splash.js`: render splash into a body-level `#splashLayer`; new `dockSplash(anchor, onDocked)` FLIP-animates the prism stage up to the hub header anchor; `removeSplashLayer()`.
- [x] `src/styles.css`: splash layer + docking transitions, slow prism spin when docked, hub grid/tile styles.
- [x] `src/main.js`: `'projects'` view, project lifecycle (`activateProject`, `openProjectById`, `createNewProject`, `deleteProjectById`, `resetPerProjectState`, `hydrateProjectMedia`), rewritten `restoreSession`, boot sequence docks splash onto the hub, brand-lockup click returns to hub.
- [x] Tests: fake IndexedDB + migration/list/delete tests in `test/browser-database.test.mjs`; new `test/projects-hub.test.mjs`; update 4 browser tests reading `projects.get('current')`.
- [x] Run `npm test` and verify — 230/230 green.

Notes: new project = `createProjectStore({storage: null}).getProject()` (fully empty). Existing project with a storyboard opens straight to storyboard; fresh ones go to the picker. Last-opened pointer in localStorage `prismflow.activeProjectId`. Delete cleanup = project `mediaAssets[].id` blobs + video frames (character/style sheets are media assets too).

## Review

- Two bugs found and fixed during verification: (1) view modules capture their data objects in closures at DOM-build time, so switching projects without rebuilding the DOM left the storyboard wheel/pan handlers mutating a stale board — `activateProject` now clears `#app` to force a rebuild; (2) `splash-rise`/`splash-breathe` animation fill state beat the dock fade's `opacity: 0`, so the docking rules also set `animation: none`.
- Deep links (`?view=editor` etc.) on an empty install create and persist a fresh project, preserving the old bootstrap behavior the browser tests rely on; with existing projects they open the last-active (localStorage `prismflow.activeProjectId`) or most recently updated one.
- Verified end-to-end with a headless Playwright smoke: splash → prism docks over hub → create → picker → structure pick → storyboard → brand-mark back to hub → reopen goes straight to storyboard → delete leaves only the "+" tile. Full `npm test` suite green (230 tests, includes the legacy-localStorage migration canaries).
- Known follow-ups deliberately deferred: project rename, revoking old blob URLs on project switch, `onblocked` handling for multi-tab version upgrades.

# Fill Gap transition (2026-07-18)

Drag "Fill gap" between two video clips → capture last/first boundary frames → LLM writes a bridging prompt from the two shots' video prompts → Veo 3.1 fast first-last-frame (4s minimum) generates the bridge → clip lands at the junction and the incoming chain is pushed right so it sits snugly.

- [x] src/gap-fill.js: constants (model, 4s), findGapFillPair (nearest junction, real gaps allowed, overlaps skipped), gapFillCaptureTimes (trim-aware), buildGapFillPrompt (offline fallback), buildGapFillPromptMessages (LLM prompt from neighboring video prompts + style bible), gapFillShiftPlan (push-right only, rightmost first, excludes the fill clip)
- [x] main.js: Fill gap card in Transitions panel (draggable, distinct styling), placeOnTimeline interception, startGapFill (frame capture via captureVideoFrame at 1280px, LLM prompt with static fallback via /api/agent/llm, submit through timelineAddGeneration with first_frame_url/last_frame_url params), finalizeGapFill in onCompleted closes the gap
- [x] video-indexing.js: export blobToDataUrl
- [x] CSS card accent; transitions-browser test count updated (8 cards incl. gap-fill)
- [x] test/gap-fill.test.mjs (7 cases) + full suite green (192 tests)

## Review

Veo 3.1 FLF schema verified against fal.ai OpenAPI: first_frame_url/last_frame_url, duration "4s"|"6s"|"8s" — 4s is the floor, used as the fill duration. Gap closing happens post-landing (not pre-submit) so a failed generation never leaves a stranded hole; push-right only, never pulls clips left when the gap is already wider than the fill. LLM prompt sources: clip provenance.prompt first (the exact submitted Seedance prompt), then the beat's saved videoPrompt. Not exercised end-to-end against live FAL (needs credits); the submit path reuses the shipped beat-video pipeline.

# Storyboard continuity & style consistency (2026-07-18)

Approved scope (from review conversation): make beat stills/videos continuous and stylistically identical across beats.

- [x] contextFor (storyboard-workspace.js): include ALL characters with sheets (not just @-mentioned) with a `mentioned` flag; add `style` (visual style bible + locked style reference asset ids, cap 4); add `previousStill` (nearest prior beat with a hero still, current act then earlier acts)
- [x] Visual style bible: `visualStyle` field on the storyboard board (project-store normalize + buildStoryboardFromStyle + editable textarea in storyboard topbar, debounced persist)
- [x] FAL still adapter: accept styleReferenceUrls/previousStillUrl/seed; image_urls order = character sheets → style refs → previous still (last); cap 14 (trim style refs, then previous still); style bible + per-group reference instructions in prompt; unmentioned cast listed as "may appear"
- [x] Screenplay + video-prompt builders: inject style bible
- [x] Browser/fake adapters: pass new groups; export stableStillSeed (deterministic first generation, random regenerate)
- [x] generateBeatStill (main.js): send all reference groups + seed; require sheets only for mentioned characters
- [x] submitBeatVideo (main.js): character sheets → Seedance image_urls alongside still (cap 4 total) + @Image2+ note in submitted prompt
- [x] CSS for visual-style bar
- [x] Tests updated/extended (storyboard-generation, storyboard-workspace, project-store) + node --test green

## Review

All 185 tests green (`npm test`), including 4 new/extended cases: reference ordering + caller seed in the FAL adapter, full-cast/style/previous-still context, stableStillSeed determinism, visualStyle round-trip. Reference-image contract is positional (characters → style refs → previous frame last) and the still prompt describes each group by position. Deterministic seed only on a beat's first generation so "Regenerate still" still rerolls. Seedance now receives the still plus up to 3 character sheets with an @Image2+ note appended only to the submitted prompt (the saved beat prompt stays clean). Not implemented (deliberate, discussed as stretch): last-video-frame → next-still chaining via ffmpeg extract-frame, Veo 3.1 first-last-frame transitions, Seedream v5 edit A/B.

# Transitions tab + timeline transitions + agent tools (2026-07-18)

Plan: ~/.claude/plans/snazzy-bubbling-bear.md (approved)

- [ ] project-store: TRANSITION_TYPES catalog, timeline.transitions (default/normalize/persist), transition/add + transition/remove commands, pruneInvalidTransitions on every dispatch + tests
- [ ] main.js: Transitions panel replaces Scenes tab (draggable tiles)
- [ ] main.js: drag/drop + snap-to-nearest-clip-edge (between-clips vs to/from-black classification), drag guide snapping
- [ ] main.js: timeline transition markers, select + Delete/× removal
- [ ] main.js + index/styles: playback rendering (incoming layer B, black overlay, applyTransitionFrame)
- [ ] agent-tools: add_transition / remove_transition / list_transitions + editor-agent prompt note + tests
- [ ] node --test green + browser verification

## Review

(pending)

# AI timeline editing agent (2026-07-17)

Plan: ~/.claude/plans/i-want-to-create-enchanted-fiddle.md (approved)

- [x] server/llm-adapter.mjs (OpenAI-compatible chat proxy, LLM_BASE_URL/LLM_API_KEY/LLM_MODEL) + server.mjs routes /api/agent/llm + /api/agent/status + .env.example + test
- [x] src/agent-runs.js (ephemeral run store: runs, steps, cancel) + test
- [x] src/agent-tools.js (read: overview/list/get/transcription/assets/search; write: move/trim/split/remove/add clip, add track, select, seek) + test
- [x] src/editor-agent.js (ReAct loop, maxIterations, abort, onStep) + test
- [x] main.js wiring: startEditorAgent, callLlm, state fields
- [x] UI: robot toolbar button beside Timeline h2, thin prompt modal, always-visible collapsed agent rail, icon-toggled half-screen stepper card, "no active agents" empty state + styles.css
- [x] npm test green + acceptance pass

## Review

- Added an ephemeral browser-side ReAct runner with visible per-action steps, cancellation, an always-visible collapsed run rail, icon-toggled run details, and immediate project-store timeline edits.
- Added server-only OpenAI-compatible proxy configuration and locked model selection to `LLM_MODEL`; browser payloads cannot override the configured model.
- Added 19 focused adapter/run/tool/loop/UI tests; the full suite passes 121/121, including the Playwright rail-toggle and timeline suites.
- Configured proxy verified against a local fake endpoint; unconfigured status/error contracts verified on a clean temporary server.
- Browser verified the editor, launch control, thin prompt modal, and configured state. The browser security policy blocked importing the local fixture, so the exact split-first-clip/remove-second-half scenario was completed through the real ReAct loop + real agent tools + real project store in memory (one 5s clip remained, timeline revision 3).

# @-mention characters in prompts (2026-07-17)

Plan: ~/.claude/plans/ok-so-now-i-sleepy-pancake.md (approved)

- [x] scripts/build-fal-model-inputs.mjs → fal-model-inputs.json (real input schemas from fal OpenAPI; 1396 models, 631 image-capable, 8 fetch failures) + test
- [x] src/prompt-mentions.js (findMentions/resolveMentionedVersions/expandMentionPrompt/imageInputFor) + tests
- [x] src/asset-data-url.js (blob → data URI, 4.5MB cap) + tests
- [x] timeline-generation: referenceImageUrls plumbed client → server → fal payload (image_url/image_urls per schema) + tests; readJson cap raised to 16MB on generate routes
- [x] character-generation: blob sheet refs converted via injected toUploadableUrl (not dropped) + tests
- [x] src/mention-autocomplete.js + .mention-menu styles
- [x] src/main.js wiring: promptMentionMap, buildMentionPayload, 3 prompt boxes, submit paths (add passes characterVersionIds; regen passes prompt+images only, provenance untouched)
- [x] node --test green (102/102); browser check: @-menu opens on typing, Enter inserts @Kalu the cat, mention map records id

## Review

- New: scripts/build-fal-model-inputs.mjs, fal-model-inputs.json, src/prompt-mentions.js, src/mention-autocomplete.js, src/asset-data-url.js + 3 test files.
- Modified: src/timeline-generation.js (referenceImageUrls in normalize), server/timeline-generation-adapter.mjs (payload image key from schema map), server.mjs (load map, 16MB body cap), src/character-generation.js (async toUploadableUrl), src/clip-regeneration.js (referenceImageUrls passthrough only — character guard untouched), src/main.js, src/styles.css.
- Mentions resolve via session mention map (name→id, survives renames) with case-insensitive longest-name-first text fallback; version precedence locked||active||latest; expanded prompt appends "Character reference — Name: prompt" blocks.
- Composer @-mentions attach other characters' sheets as image references without rewriting the typed prompt.
- Not verified live against paid fal models (fake-adapter + unit coverage only). Refresh schema map with `node scripts/build-fal-model-inputs.mjs` after catalog syncs.

# PrismFlow UI Revamp — Prismatic Refraction

Plan: ~/.claude/plans/memoized-baking-rossum.md (approved 2026-07-16)

- [ ] Rewrite `src/styles.css` with the prismatic-refraction design system (CSS-only; keep every class/id/data-* hook)
- [ ] Update `index.html` theme-color meta to new canvas color
- [ ] `npm test` passes (incl. Playwright browser suite: ew-resize handle + preview `.visible` assertions)
- [ ] Visual pass in Chrome at localhost:4173 (empty state, clips, ghost review, modal, toast; compact <760px height)
- [ ] Review section below

## Review

(pending)

## Context menus (2026-07-17)
- [x] Reusable `showContextMenu`/`closeContextMenu` helpers in src/main.js
- [x] Media sidebar: right-click card → Remove; blank area → Import media…
- [x] Timeline: right-click clip → Remove (new `removeClip`, reused by Backspace)
- [x] `.context-menu` styles matching `.track-menu` idiom
- [x] Verified in browser: all three menus shown, clip removal confirmed; 79/79 tests pass

## Generate video from timeline (2026-07-17)
- [x] "Generate video" on right-click of empty video lane (trackId + time captured from cursor)
- [x] Modal: prompt composer, model dropdown (name · category · tags — $price/unit), duration select (model default / 4–12s) for video models
- [x] Catalog from IndexedDB modelPricing store, fallback /fal-model-pricing.json (re-cached to IndexedDB)
- [x] Submit → createTimelineGenerationController → landGenerationResult → auto-accept diff → clip inserted at right-click position; usage recorded
- [x] Duration passed as params.duration to FAL; per-second models show estimated cost for chosen duration
- [x] Verified end-to-end in browser with ?timelineAdapter=fake; inserted at V1 00:12.7 with 5s duration; test clip/asset cleaned up; 79/79 tests pass

## Veo 3.1 fix + ghost clip flow (2026-07-17)
- [x] Fixed FAL 405 "Method not allowed": queue status/result must poll the root app id (fal-ai/veo3.1), not the full nested endpoint path (fal-ai/veo3.1/fast) — server/fal-adapter.mjs; regression test added
- [x] Submit now closes the modal and shows a pulsing dashed ghost clip at the picked spot while generating async
- [x] On completion: asset downloaded to IndexedDB (blob, object URL swap), added to media bin, ghost replaced by real clip
- [x] Verified in browser (fake adapter): ghost shown at spot → replaced by inserted clip; 80/80 tests pass; test clips/assets cleaned up

## Generated-clip context menu (2026-07-17)
- [x] Right-click on a generated clip (has provenance.prompt+modelId): Regenerate clip / Modify prompt + regen / Delete; regular clips keep Remove
- [x] Regenerate = reroll seed via clipRegeneration, auto-applied on completion (useCandidate → accept diff → persist asset)
- [x] Modify prompt + regen reopens the same modal prefilled (prompt, model, duration) in replace mode
- [x] Clip pulses (dashed outline) while its regeneration is in flight
- [x] Fake adapter job ids now session-prefixed to avoid diff-history collisions across reloads
- [x] Verified all three actions in browser; 80/80 tests pass; test assets cleaned up

# Detach audio from timeline video clips (2026-07-18)

Plan: ~/.claude/plans/hashed-tumbling-volcano.md (approved)

- [x] src/audio-extract.js (AudioContext decode → 16-bit WAV encode, typed no-audio error, 16kHz mono resample) + test
- [x] project-store: clip/detach-audio command (audio asset import + aligned A1 clip + audioDetached flag on source clip; persisted in toPersistedProject/normalizeClip) + tests
- [x] main.js: "Detach audio" clip context-menu item (video clips only, hidden once detached), detachAudioFromClip (blob from IndexedDB/URL → extract → putAsset → dispatch → transcribe), previewVideo muted when clip.audioDetached, audioIndexer resume on boot
- [x] src/audio-indexing.js (in-browser Whisper via @huggingface/transformers, segments → asset.metadata.transcription + audioIndex status, records POSTed to existing /api/video/index for semantic search) + tests
- [x] index.html import map for @huggingface/transformers (self-contained dist/transformers.min.js) + server.mjs .wasm content type
- [x] agent-tools get_clip_transcription: audio clips slice metadata.transcription.segments by source window + test
- [x] npm test green (135/135)

## Review

- Detach = one atomic store command modeled on clip/split: full-source WAV asset (kind audio) so trim/split/persistence work unchanged; audio clip copies start/duration/sourceStart so alignment survives prior trims.
- Original video clip keeps playing video but is muted via clip.audioDetached; the detached A1 clip supplies sound through the existing #previewAudioMix path.
- Transcription reuses the video search index verbatim (records only need searchText), so spoken phrases are semantically searchable with zero server-side changes; records carry kind:'audio-transcript'.
- Whisper (whisper-tiny.en) runs locally at detach time, not at import, to avoid the model download/inference cost on every video; failed/interrupted transcriptions resume on reload via metadata.audioIndex.
- Not verified live with a real speech video in-browser yet (unit coverage + app smoke test only); first detach downloads ~40MB of Whisper weights.

# Normalized transitions + AI transition generator (2026-07-18)

Plan: ~/.claude/plans/adaptive-gathering-summit.md (approved)

- [x] src/transitions.js — new single-module home for transitions: declarative TransitionDefinition schema (mode + keyframed CSS tracks on layerB/fade), the 6 built-ins expressed in it, generic numeric-lerp interpreter (no eval), validator with property/target whitelists + skeleton-match rule, key slugifier, LLM few-shot prompt builder
- [x] project-store: TRANSITION_TYPES now derived/re-exported from transitions.js; project.customTransitions array (normalized on load, persisted); transition lookups custom-aware; transition-def/create + transition-def/remove reducers (remove also drops timeline instances using the key)
- [x] main.js: applyTransitionFrame/activeTransitionAt now interpret definitions generically (hardcoded if/else chain deleted); transitions panel renders built-ins + custom cards (with hover delete) + "[+] AI transition" card; composer modal (name + prompt) → /api/agent/llm with built-ins as examples → parse/validate → saved as custom transition; LLM-unconfigured note + error-in-modal retry path
- [x] agent-tools: add_transition accepts custom keys (static enum removed, call-time validation); editor-agent system prompt mentions custom transitions
- [x] styles.css: add-card, custom badge, delete-button styles only (no per-type CSS existed)
- [x] test/transitions.test.mjs (schema/interpolation/validation/keys/prompt), custom-def reducer test in project-store.test.mjs, test/transitions-browser.test.mjs (Playwright: custom transition renders clip-path mid-blend, composer creates a card from a mocked LLM reply)
- [x] npm test green (148/148)

## Review

- A transition is now data: {key, label, glyph, defaultDuration, mode, tracks[{target, property, keyframes[{at, value}]}]}. Between keyframes every number in the CSS value lerps; adjacent values must differ only in their numbers (validated), so no eval and nothing reaches the DOM except whitelisted style properties.
- Built-in behavior is bit-identical to the old hardcoded chain (unit-asserted against the legacy formulas, e.g. wipe-left at p=0.25 → inset(0 0 0 75%)).
- Custom transitions live on project.customTransitions (characters/styles pattern): persisted to IndexedDB via the existing onCommit, pruned self-healingly if a definition disappears, deleted definitions take their timeline instances with them.
- LLM flow reuses /api/agent/llm + /api/agent/status; a malformed model reply (bad JSON or schema violation) surfaces the exact validator error in the modal with inputs preserved — verified in the browser test debug run.
- Lone-edge (to/from black) fades remain fixed behavior regardless of definition, as before.

# Splash → narrative style picker → storyboard canvas (2026-07-18)

Plan: ~/.claude/plans/i-want-to-create-shimmering-turing.md (approved)

- [x] src/data/narrative-styles.js — full dataset from drawing.svg (~33 storyline types, titles = structure name, authors in tagline, ≤4 acts with beats + notes)
- [x] main.js — view dispatch (splash | picker | storyboard | editor), ?view= param, splash dismissal wiring
- [x] src/splash.js + CSS — scaled brand-mark prism, bloom glow, "Prism" wordmark, fade-out
- [x] src/style-picker.js + CSS — card grid, Custom first, selection + Next
- [x] src/storyboard.js + CSS — comfy-ui canvas: seeded act boxes + outside notes, pan, node drag, Jump to editor
- [x] Verify: npm run dev + browser pass; existing tests still green

## Review

- New pre-editor flow: splash (scaled .brand-mark prism + bloom glow + "Prism" wordmark, min 2.2s, fades once IndexedDB session restore settles) → structure picker (33 cards: Custom + every row of the drawing.svg story-structure chart, card title = storyline type, authors in the sub-tagline) → storyboard canvas (pannable dotted grid, draggable act boxes with beats as chips + amber note cards seeded outside the act row, double-click-to-edit summaries, Jump to editor → top right).
- main.js touched minimally: renderApp is now a 4-way view dispatcher over the untouched renderEditorApp; ?view=editor|picker|storyboard|splash deep-links any view (browser tests use it).
- Storyboard state is its own module (pointer-move mutations write transforms directly, never renderApp); dataset is an ESM module src/data/narrative-styles.js, all strings HTML-escaped at render.
- Verified via Playwright script: splash/picker/storyboard/editor screenshots, drag + pan, act counts per structure (Hero's Journey=4, Two-Act Musical=2), zero console errors; full npm test suite 155/155 green.

# Light theme ("prism light on a white wall") (2026-07-18)

- [x] :root tokens flipped to light (white bg, ink text, dark-alpha surfaces/lines, darkened cyan/teal/amber/rose for contrast)
- [x] body::before/::after — the only rainbow left: faint blurred spectral streaks on white that drift and breathe on two unsynced clocks (47s/61s drift, 19s/27s glow), reduced-motion safe
- [x] --spectral / -soft / -faint redefined to a single blue accent → all UI rails, strips, borders, act headers lost the rainbow at the token level
- [x] Full-file audit: ~80 hardcoded dark-theme colors converted (glass inputs → white, black shadows → soft navy, light-gray strongs → ink, chromatic cyan/pink rings → single accent, playhead/drag guides → ink, primary button → solid ink, modal scrim → light veil, storyboard notes → amber-on-cream)
- [x] Kept dark deliberately: video mattes/thumbnails (+ pinned light text inside them), type badges, prism logo glass faces
- [x] Verified: screenshots of splash/picker/storyboard/editor, npm test 155/155 green

# Background score generation (implemented 2026-07-18)

Goal: after a video is generated, produce one continuous background music track for the
whole timeline, directed by an LLM from (a) per-beat video prompts, (b) overall theme,
(c) act/scene narrative structure, (d) Moondream frame annotations — with musical hits
landing on reveals/climaxes.

## Model choice (from local fal directory: fal-model-pricing.csv)
- Primary: `fal-ai/elevenlabs/music` ($0.80/min) — only model with fine-grained control
  (prompt + exact length; composition-plan style sectioned direction). Best fit for
  LLM-directed cue sheets.
- Quality alt: `fal-ai/lyria3/pro` ($0.08/audio) — top raw quality, single-prompt only.
- Sync shortcut: `sonilo/v1.1/video-to-music` ($0.009/s) — takes the rendered video and
  returns a frame-synced, licensed track; zero-effort baseline, less narrative control.
- Editing family: `fal-ai/stable-audio-3/medium/*` — outpaint/inpaint endpoints let us
  extend or rework a section without regenerating the whole score.
- Rejected: minimax-music (vocal/song-oriented), ace-step (lyrics-first, no prompt key),
  cassetteai (quality), stable-audio open (short/ambient).

## Plan
- [x] 1. Score-direction builder (server/score-direction.mjs): assemble ScoreContext
      {theme, structure name, acts→scenes→beats with absolute start/end ms from timeline,
      per-beat prompts + screenplay, Moondream annotations of 1-2 frames per clip} and
      prompt the existing llm-adapter to emit a strict-JSON cue sheet (schema below).
- [x] 2. Structural-moment tagging: derive reveal/climax/resolution candidates from the
      narrative-structure dataset (act position) + LLM confirmation; each becomes a
      musical hit point with absolute timestamp.
- [x] 3. Prompt composer: cue sheet → model input. ElevenLabs: sectioned prompt +
      music_length_ms = timeline duration. Lyria: single condensed prompt. Sonilo:
      rendered video URL + style prompt.
- [x] 4. server/music-generation-adapter.mjs (fake + real, same job pattern as
      storyboard/timeline adapters) + /api/music routes in server.mjs; key stays server-side.
- [x] 5. Beat alignment pass: decode returned track with Web Audio (reuse
      audio-extract.js), onset/beat detection → nearest-beat offset for each hit point;
      nudge music track offset (and optionally clip cuts within ±300ms) so hits land.
- [x] 6. Timeline integration: add generated track as an audio-track clip (timeline
      already supports audio tracks), with per-section gain envelope / ducking later.
- [x] 7. Tests: fake adapter round-trip, cue-sheet schema validation, beat-snap math.

## Cue-sheet JSON schema (LLM output)
{ global: {genre, bpm, key, instrumentation[], moodArc},
  sections: [{startMs, endMs, actId, sceneId, intensity 1-10, description,
              transition: "cut"|"swell"|"drop"|"decay"}],
  hitPoints: [{timeMs, kind: "reveal"|"climax"|"turn", treatment}] }
LLM must choose bpm so key section boundaries fall on bar lines
(barMs = 240000/bpm; boundaries snapped to multiples).

## Review (background score)

- Shared cue-sheet model lives in src/score-direction.js (normalize/repair LLM JSON into
  contiguous 3–120s sections, bar-line quantization at the chosen BPM, ElevenLabs
  composition-plan mapping with force_instrumental, single-prompt fallback for Lyria-class
  models, and buildScoreContext over the "all"-view timeline + storyboard acts + Moondream
  annotations from the browser video-frame index).
- server/music-generation-adapter.mjs directs via openrouter/router (same seam as
  storyboard scripts, PRISMFLOW_SCORE_DIRECTION_MODEL) and renders via
  fal-ai/elevenlabs/music by default (PRISMFLOW_MUSIC_MODEL; fal-ai/lyria3/pro and
  sonilo/v1.1/video-to-music also supported at the adapter level). Routes:
  POST /api/music/score-direction, POST /api/music/generate (202), GET /api/music/jobs/:id.
- src/music-sync.js: energy-flux onset detection + global offset search aligning detected
  beats to cue-sheet hit points, and scoreClipPlacements windowing one audio file across
  the scene-local timeline via sourceStart (this is how one continuous score spans acts
  without shifting act offsets).
- main.js: "♪ Score" button in the timeline toolbar (Directing…/Composing…/Rendering…
  phases), fake adapter behind ?musicAdapter=fake, landing imports the audio asset
  (cue sheet + beat delay in metadata), persists the blob, and adds one A1 clip per act.
- Verified: 32 new tests (score-direction 12, music-sync 8, music-generation 11, plus a
  Playwright smoke test driving the fake adapter end-to-end and asserting the per-act
  clip windows in IndexedDB); full suite 224/224 green.

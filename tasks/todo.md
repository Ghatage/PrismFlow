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

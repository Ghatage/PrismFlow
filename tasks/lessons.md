
## 2026-07-18 — Light-theme conversion
- Changing `:root` tokens is never enough: this stylesheet had ~80 hardcoded dark-theme colors (light-gray text, dark glass inputs, black shadows, white text-clip gradients). After any theme flip, grep for hex/rgba literals AND read the full stylesheet, then verify each view with screenshots before presenting — the user found the black-blob play button and pale track labels before I did.
- When the user asks for a decorative motif (prism rainbow), keep it scoped to exactly where they asked (background streaks only); redefining the shared accent tokens (--spectral*) to a single hue was the cheap way to strip it everywhere else at once.
- Text sitting on media mattes (video frames, thumbnails) must keep light colors independent of theme tokens — pin those explicitly.

## 2026-07-18 — fal ElevenLabs Music: music_length_ms vs composition_plan
- The endpoint 422s when `music_length_ms` is sent alongside `composition_plan`; the
  summed section `duration_ms` values alone define total length. Scraped API docs list
  fields as individually optional but omit mutual-exclusion constraints — when composing
  payloads for a paid endpoint from doc scrapes, send the minimal field set and treat
  overlapping "length" controls as either/or until proven otherwise.
- Follow-up: `force_instrumental` is likewise rejected next to `composition_plan`. The
  plan-mode payload is exactly {composition_plan, respect_sections_durations,
  output_format}; every prompt-mode convenience flag conflicts. Should have stripped all
  sibling flags after the first 422 instead of removing them one at a time.

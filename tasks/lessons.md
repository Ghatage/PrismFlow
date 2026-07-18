
## 2026-07-18 — Light-theme conversion
- Changing `:root` tokens is never enough: this stylesheet had ~80 hardcoded dark-theme colors (light-gray text, dark glass inputs, black shadows, white text-clip gradients). After any theme flip, grep for hex/rgba literals AND read the full stylesheet, then verify each view with screenshots before presenting — the user found the black-blob play button and pale track labels before I did.
- When the user asks for a decorative motif (prism rainbow), keep it scoped to exactly where they asked (background streaks only); redefining the shared accent tokens (--spectral*) to a single hue was the cheap way to strip it everywhere else at once.
- Text sitting on media mattes (video frames, thumbnails) must keep light colors independent of theme tokens — pin those explicitly.

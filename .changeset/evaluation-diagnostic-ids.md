---
"@topik/content": patch
---

Compilation reports the same diagnostic for an evaluation failure wherever it occurs. Interpolated text that exceeds `dataStringLength` is `topik-content-limit` on the variable's line even when no `t"…"` or code template comes before it, and a video or YouTube title that interpolates to blank text reports `topik-video-title` or `topik-youtube-title` with its line instead of a critical `topik-transform-failed`. Unused message entries for Markdoc-era diagnostic IDs are removed.

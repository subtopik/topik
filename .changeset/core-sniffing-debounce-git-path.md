---
"@topik/core": patch
---

Recognize TIFF (`image/tiff`), AAC in ADTS framing (`audio/aac`) and WebM
(`video/webm`) assets from validated headers; Matroska that is not WebM stays a
download. Add a `debounceMs` option to `watch()` (default
`DEFAULT_WATCH_DEBOUNCE_MS`, 100 ms) and a `gitExecutable` option to `compile()`,
`lint()`, `watch()` and `readPortableAssetFile()` for a Git installed outside the
fixed trusted locations.

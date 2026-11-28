---
"@topik/remark-tags": patch
"@topik/content": patch
---

Harden URL checks, preserve diagnostic attributes, and keep unterminated tag scopes open. `validateTopikHref` now requires a lowercase `asset:` scheme and strict `http://`/`https://` URLs without a base URL, `parseTopikYouTubeUrl` rejects control characters and non-`https://` prefixes, diagnostic sanitization preserves `tag` and `attribute` for `topik-accordion-id`, `topik-video-youtube`, `topik-video-title`, `topik-youtube-src`, and `topik-youtube-title`, and `parseTag` records `opening` on unterminated component openers so matching closing tags do not emit a spurious `missing-opening` diagnostic.

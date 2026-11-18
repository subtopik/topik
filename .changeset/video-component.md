---
"@topik/content": patch
"@topik/content-react": patch
"@topik/core": patch
"@topik/cli": patch
---

Add a `video` component for local and external video.

- `{% video src="…" title="…" /%}` is a self-closing block, allowed wherever `figure` is. `src` and `title` are required; `caption`, `poster` and `loop` are optional, and `title` and `caption` accept text templates. `src` is a local file or a credential-free HTTPS URL, kept exactly as written, including a query such as a start time. Topik knows no video services: an application that allows only some checks the new `video.src` occurrence.
- The asset reference protocol gains the `video.src` slot with the new `video` role and the `video.poster` slot with the `image` role. Occurrences report the video's title in `semantics.title` or `semantics.titleTemplate`. Removing an unsafe poster keeps the video; removing an unsafe source leaves the title and caption as text.
- The compiler accepts only MP4 and WebM for `video.src` and refuses QuickTime, 3GPP, audio-only files and images with `TOPIK_ASSET_MEDIA_TYPE_MISMATCH`. A video and its poster need a non-empty `title`.
- The theme's `TopikVideo` plays the source in a native player named by its title, and falls back to the poster and title as a link when the browser cannot play it. `loop=true` plays a muted looping clip with a Pause button, paused for readers who prefer reduced motion and with native controls until hydration. Print shows the poster, title and address instead of the player. Without a themed component, a video renders as a plain link.
- Preview streams video instead of downloading and hashing it first: the adapter gives a `video.src` slot the session-bound blob URL for MP4 and WebM payloads, and the renderer passes `crossOrigin="anonymous"`. `topik dev` answers single `Range` requests with 206 or 416 and advertises `Accept-Ranges: bytes`.

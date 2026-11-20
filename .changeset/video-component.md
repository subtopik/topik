---
"@topik/content": patch
"@topik/content-react": patch
"@topik/core": patch
"@topik/cli": patch
---

Add a `video` component for local and external video.

- `{% video src="…" title="…" /%}` is a self-closing block, allowed wherever `figure` is. `src` and `title` are required; `caption`, `poster` and `loop` are optional, and `title` and `caption` accept text templates. `src` is a local file or a credential-free HTTPS URL, kept exactly as written, including a query such as a start time. Topik knows no video services: an application that allows only some checks the new `video.src` occurrence.
- The asset reference protocol gains the `video.src` slot with the new `video` role and the `video.poster` slot with the `image` role. Occurrences report the video's title in `semantics.title` or `semantics.titleTemplate`. Removing an unsafe poster keeps the video; removing an unsafe source leaves the title and caption as text.
- The compiler accepts only files detected as MP4 or WebM for `video.src` and refuses files detected as QuickTime, 3GPP, audio or an image with `TOPIK_ASSET_MEDIA_TYPE_MISMATCH`. Detection reads the container header, not its tracks or codecs. A `video` title cannot be blank (`topik-video-title`), except for a template with a variable.
- The theme's `TopikVideo` plays a compiled source, or a URL whose path ends in `.mp4`, `.m4v` or `.webm`, in a native player named by its title. Any other URL, such as a page on a hosting service, renders as the poster and title as a link, without script and without a request to the service; so does a source the browser fails to play. `loop=true` plays a muted looping clip with a Pause button, paused for readers who prefer reduced motion and with native controls until hydration. Print shows the poster, title and address instead of the player. Without a themed component, a video renders as a plain link.
- Preview streams video instead of downloading and hashing it first: the adapter gives a `video.src` slot the session-bound blob URL for MP4 and WebM payloads, and the renderer passes `crossOrigin="anonymous"`. A poster that fails to load or decode is left out and the video stays. `topik dev` answers a `GET` with a single `Range` with 206 or 416 and advertises `Accept-Ranges: bytes`; it ignores ranges on `HEAD` and with `If-Range`.
- Removing an unsafe `figure` or `video` source keeps template variables in the remaining text, so evaluation still fills them in.

Breaking:

- `video` is now a canonical component. An application that registered its own `video` in `config.components` must rename that schema and the tags that use it together; the built-in schema takes its place.
- `TopikComponentName` and `TopikComponentMap` in `@topik/content-react` include `TopikVideo`. A hand-written complete `TopikComponentMap` must add it; partial override maps are unaffected.

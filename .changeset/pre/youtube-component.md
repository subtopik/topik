---
"@topik/content": patch
"@topik/content-react": patch
---

Add a `youtube` component.

- `{% youtube src="https://youtu.be/…" title="…" /%}` embeds a YouTube video. `src` takes the URL as YouTube shares it (`youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/`, `/live/` and `/embed/` paths), and a `t` or `start` parameter sets the start time; anything else is refused with `topik-youtube-src`. `title` is required and not blank (`topik-youtube-title`), and `caption` is optional.
- The theme's `TopikYouTube` shows the title as a link to the video and loads the player from `youtube-nocookie.com` only when the reader activates it, so the page makes no request to YouTube before that. Without script, in print and in the plain renderer, the link opens the video on YouTube. A page with a Content-Security-Policy must allow `frame-src https://www.youtube-nocookie.com`.
- `@topik/content` exports `parseTopikYouTubeUrl`, `topikYouTubeWatchUrl` and `topikYouTubeEmbedUrl`.

Breaking:

- `youtube` is now a canonical component. An application that registered its own `youtube` in `config.components` must rename that schema and the tags that use it together; the built-in schema takes its place.
- `TopikComponentName` and `TopikComponentMap` in `@topik/content-react` include `TopikYouTube`. A hand-written complete `TopikComponentMap` must add it; partial override maps are unaffected.

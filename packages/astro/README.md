# @topik/astro

Astro content loaders and an integration for Topik wikis and guide collections.
This package is private to the workspace and is not published to npm.

## Usage

Create loaders for a wiki directory (with `wiki.yaml`) or a guide collection
(with `collection.yaml`), register them with the integration, and use them in
content collections:

```js
// topik-loaders.mjs
import { topikGuidesLoader, topikWikiLoader } from "@topik/astro";

export const wikiLoader = topikWikiLoader({ dir: "./handbook", name: "handbook" });
export const guidesLoader = topikGuidesLoader({ dir: "./tutorials", name: "tutorials" });
```

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import { topik } from "@topik/astro";
import { guidesLoader, wikiLoader } from "./topik-loaders.mjs";

export default defineConfig({
  integrations: [topik({ loaders: [guidesLoader, wikiLoader] })],
});
```

```js
// src/content.config.mjs
import { defineCollection } from "astro:content";
import { guidesLoader, wikiLoader } from "../topik-loaders.mjs";

export const collections = {
  guides: defineCollection({ loader: guidesLoader }),
  wiki: defineCollection({ loader: wikiLoader }),
};
```

The integration serves compiled asset payloads in development and publishes them
with the build. `createTopikLinkResolver` maps Topik resource references to
application routes.

## License

MIT

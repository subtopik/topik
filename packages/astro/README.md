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

`createTopikLinkResolver` maps Topik resource references to application routes.

## Navigation

A wiki loader's `getNavigation()` compiles the wiki directory and resolves to its
`navigation` tree (`WikiNavNode[]`), for rendering a sidebar:

```astro
---
import { wikiLoader } from "../../topik-loaders.mjs";
const navigation = await wikiLoader.getNavigation();
---
```

## Assets

Local images and downloads referenced from Markdown compile to `asset:<name>`
references in entry bodies. Each loader exposes the current compiler snapshot:

- `loader.resolveAsset(name)` returns the payload URL (`<base>blobs/<sha256>`),
  or `undefined` for a name the compilation did not emit.
- `loader.getAssets()` returns the compiled Asset descriptors.

The integration serves these payloads from memory in development and in server
output (`Cache-Control: no-cache` in development; `public, max-age=31536000, immutable`
in production, since paths are content-addressed). Opaque downloads
(`application/octet-stream`) are sent with `Content-Disposition: attachment`; the
compiler already rejects active media such as HTML and SVG. A build also writes the
payloads to `blobs/` in the static (client) output directory.

Reading local Asset files and writing `blobs/` require Linux, where both stay
anchored to opened directory descriptors. On other platforms a site without local
Assets builds normally; a local Asset reference fails compilation, and a build that
would publish or replace a `blobs/` directory fails with
`Topik Asset publication requires Linux`.

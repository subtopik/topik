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
import { createProjectAssetNameGenerator } from "@topik/core";

// Local images and downloads need generated names; a page with one fails without this.
const assets = {
  generateName: createProjectAssetNameGenerator({
    projectRoot: ".",
    projectNamespace: "example/site",
  }),
};

export const wikiLoader = topikWikiLoader({ dir: "./handbook", name: "handbook", assets });
export const guidesLoader = topikGuidesLoader({ dir: "./tutorials", name: "tutorials", assets });
```

A guide loader does not read `.topik.yaml`. When the guides name authors, pass the Persons the manifest declares as `persons`, for example `persons: [{ apiVersion: "v1", type: "Person", name: "ada", spec: { name: "Ada" } }]`.

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

## Exports

`@topik/astro` is the only entry point.

| Export                    | Provides                                                              |
| ------------------------- | --------------------------------------------------------------------- |
| `topikWikiLoader`         | A content loader for a wiki directory.                                |
| `topikGuidesLoader`       | A content loader for a guide collection.                              |
| `topik`                   | The Astro integration that delivers the loaders' asset payloads.      |
| `createTopikLinkResolver` | A resolver that maps Topik resource references to application routes. |

See [Resolve links in Astro](https://github.com/subtopik/topik/blob/main/docs/resources/navigation.md#resolve-links-in-astro)
for link resolution and the
[Astro integration](https://github.com/subtopik/topik/blob/main/docs/resources/assets.md#astro-integration)
section of the assets guide for asset naming.

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
references in entry bodies. Each loader exposes its current compiled snapshot:

- `loader.resolveAsset(name)` returns the payload URL (`<base>blobs/<sha256>`),
  or `undefined` for a name the compilation did not emit.
- `loader.getAssets()` returns the compiled Asset descriptors.

The integration serves payloads from memory in development and in server output.
A build also writes them to `blobs/` in the static (client) output directory.

| Response header       | Value                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cache-Control`       | `no-cache` in development; `public, max-age=31536000, immutable` in production, because payload paths are content-addressed                 |
| `Content-Disposition` | `attachment` for media types a browser could display or execute from the site origin, such as opaque downloads (`application/octet-stream`) |

The compiler rejects active media such as HTML and SVG, so in practice
`Content-Disposition: attachment` applies to opaque downloads.

### File safety during builds

How a build protects local Asset files and the `blobs/` directory depends on the
platform:

- **Linux:** reading local Asset files and writing `blobs/` are anchored to
  opened directory descriptors.
- **macOS and Windows:** directory anchoring is unavailable, so the build uses
  Topik's portable file safety, the same default as `topik compile`. It checks
  paths and file identity, which cannot stop another process from changing the
  workspace during a build. The integration logs one warning per build saying
  so. Build only in a workspace you trust.

On every platform, a build replaces only an empty `blobs/` directory or one
written by a previous build (every entry a file named by the SHA-256 of its
bytes). It refuses a symbolic link or any other content.

---
title: Assets
description: Compile local images and downloads, preserve their identity, and deliver their bytes.
---

# Assets

Authors reference local images and downloads in Markdown. During resource
compilation, Topik discovers supported files, emits `Asset` resources, and
rewrites those references to `asset:<generated-name>`. Applications deliver the
compiled bytes and resolve those names to reader-facing URLs.

## Reference a local file

```text
handbook/
  .topik.yaml
  wiki.yaml
  content/
    overview.md
  images/
    setup.png
  downloads/
    checklist.pdf
```

In `content/overview.md`, paths are relative to that Markdown file:

```markdown
![Setup screen](../images/setup.png)

[Download the checklist](../downloads/checklist.pdf)
```

The resolved file must remain inside the local configuration directory. Here,
`.topik.yaml` declares `wiki.yaml`, and `handbook/` is the project root. Asset
identity paths are `images/setup.png` and `downloads/checklist.pdf`, relative to
the directory containing the manifest. With a manifest one level above
`handbook/`, those paths would include the `handbook/` prefix.

Discovery covers Markdown images, `figure` light/dark sources, and local Markdown
links proven to be supported regular-file downloads. It checks all authored
conditional branches. Frontmatter, captions, arbitrary strings, and card
navigation links do not create assets.

Credential-free HTTPS images and downloads stay external references. The
compiler does not download them or create asset descriptors for them. HTTP and
credential-bearing asset URLs are refused.

## Set a stable project namespace

Declare the namespace in the required `.topik.yaml`:

```yaml
version: 1
namespace: example/handbook
sources:
  - kind: wiki
    config: wiki.yaml
```

```sh
npx topik compile ./handbook --validate
```

Use the same namespace across checkouts, archives, and CI builds of the same
project. Independent projects should use different values; no global registry
enforces uniqueness. The CLI does not derive a namespace from Git or accept an
override. See [Project manifest](./manifest.md) for the full contract.

Explicit standalone library calls such as `compileWiki` and `compileGuides`
remain independent of manifests. They accept an `assets.generateName` callback;
see [Standalone asset naming](#standalone-asset-naming).

## Standalone asset naming

`compileWiki`, `compileGuides`, and `compileAssetResources` accept a naming callback
without requiring a manifest. `assets.generateName` (or `generateName` directly
on `compileAssetResources`) receives `{ resolvedAssetPath }`: the absolute native
file path after reference resolution. It must return a stable canonical `auto-v1-…`
name, synchronously or asynchronously. It is called once per distinct asset path
in a compilation. Missing callbacks fail only when local assets are encountered;
content without local assets needs no naming configuration.

For the standard project policy, create a callback with an explicit root and
namespace:

```ts
import { resolve } from "node:path";
import { compileWiki, createProjectAssetNameGenerator } from "@topik/core";

const projectRoot = resolve("./content");
const generateName = createProjectAssetNameGenerator({
  projectRoot,
  projectNamespace: "example/handbook",
});
const result = await compileWiki({
  dir: projectRoot,
  configFile: "handbook/wiki.yaml",
  assets: { generateName },
});
```

The helper reads no manifest. It hashes the namespace and portable path relative
to `projectRoot`, and rejects files outside that root. If those values match a
manifest build, asset IDs match too, including for nested configurations and
shared files. Never hash the absolute checkout path if IDs must survive relocation.
For custom callbacks, the caller owns stability and uniqueness across compilations.
Within a compilation, the compiler validates names and rejects different paths
mapped to the same name. File admission, payload hashing, deduplication, content
rewriting, and inventory validation remain compiler responsibilities.

## Generated identity

In project builds, an asset's generated name identifies its project namespace and manifest-relative source location. Its payload digest
identifies its bytes. Those identities have different uses:

| Change                       | Generated name | Payload digest                    |
| ---------------------------- | -------------- | --------------------------------- |
| Edit a file at the same path | Preserved.     | Changes when its bytes change.    |
| Move a file                  | Changes.       | Preserved if its bytes are equal. |
| Change the project namespace | Changes.       | Preserved if its bytes are equal. |
| Use equal bytes at two paths | Two names.     | One shared payload.               |

Generated names use `auto-v1-` followed by 52 lowercase base32 characters; the
final character is `a` or `q`. The suffix encodes the complete SHA-256 digest of:

```text
UTF8(NFC(project-namespace)) + NUL + UTF8(manifest-relative-asset-path)
```

Within a project, references to the same file share an ID, including references
from overlapping Wiki and collection directories. Different manifest-relative
paths produce different IDs. Independent projects with the same namespace and
matching paths produce the same IDs, so choose distinct namespaces deliberately.
Moving a checkout or changing its Git remote preserves IDs.

Topik owns that derivation. Authors keep ordinary local references in editable
source and do not assign generated names themselves.

## New media destination

Each Wiki or collection configuration can select the destination for new synced media:

```yaml
# docs/wiki.yaml (also supported in collection.yaml)
id: docs
title: Documentation
assets:
  directory: _assets
```

`assets.directory` defaults to `_assets` beside the local configuration. Override it with a normalized portable relative directory, for example `media/uploads`. The path is relative to that configuration's directory, never to the process working directory. Absolute paths, URLs, traversal, case/Unicode-unsafe spelling, and reserved `.git`/`.topik` paths are rejected. The root `.topik.yaml` declares the project namespace and source pointers; it has no asset defaults or inheritance.

This setting chooses where **new** media will be written during source synchronization. It does not move existing media, restrict which local media can be referenced, change Asset namespaces, or relocate compiled `blobs/` output. Compilation neither creates the destination nor writes files there. Source write-back is not implemented by this feature; it must preserve existing paths, use deterministic filenames, and reject destination conflicts without overwriting unrelated files. A destination setting grants no ownership over existing files.

Configurations in the same directory share `_assets` by default, and may each override their destination. Shared directories alone are not conflicts. At write time, the complete resolved destination and filenames must pass the existing containment, file-type and collision checks; an existing file cannot be treated as a directory or overwritten by implication. The directory need not exist when compiling.

The public Wiki/collection parsers return the effective `assets.directory`, including the default. Manifest compilation exposes each source's resolved manifest-relative `assetDirectory` in its provenance. `sourceAssetsConfigSchema`, `SourceAssetsConfig` and `DEFAULT_ASSET_DIRECTORY` are exported for tools using the same contract.

## Compiled output

The CLI writes this tree under `<source-root>/.topik`, or under `--out-dir`:

```text
.topik/
  semantic.json
  materialization.json
  resources/
    Wiki/<wiki-name>.json
    WikiPage/<page-name>.json
    Asset/<generated-name>.json
  blobs/
    <full-lowercase-sha256>
```

Other resource kinds use the same `resources/<type>/<name>.json` layout. The
`resources/` and `blobs/` directories exist even when empty.

An Asset descriptor contains its generated `name`, a `spec.uri` of
`blobs/<digest>`, matching `spec.integrity` of `sha256:<digest>`, the exact byte
`size`, and a verified `mediaType`. Equal payload bytes are written once per
compilation, even when several source locations have separate asset names.

`semantic.json` records generated names and their declared content occurrences.
`materialization.json` records resource and payload paths, sizes, and digests.
Transfer those inventories together with the descriptors and blobs. A complete
materialization must agree with the resources and content references; separate
schema validation of an Asset is not proof that its bytes are present or correct.

## Render compiled assets

Build a resolver from the descriptors and the URL where your application serves
compiled blobs. For a server exposing `blobs/` under `/published/blobs/`:

```tsx
import { TopikContent } from "@topik/content-react/theme";
import type { Asset } from "@topik/schema/asset/v1";

export function PublishedPage({ content, assets }: { content: string; assets: Asset[] }) {
  const assetUrls = new Map(assets.map((asset) => [asset.name, `/published/${asset.spec.uri}`]));
  return <TopikContent content={content} resolveAsset={(name) => assetUrls.get(name)} />;
}
```

`content` here is the compiled Markdown containing generated references.
The resolver maps names; the application must also serve the actual blobs.
A source-relative path is not a delivery URL. Missing or malformed generated
references produce a diagnostic and omit the unresolved browser-facing URL.
Resolution applies only to declared asset fields.

### Astro integration

`@topik/astro` is currently a private workspace package. Applications using that
integration pass the same loader instances to their content collections and
Topik integration so that page content and delivery share one compiled snapshot:

```ts
import { topik, topikWikiLoader } from "@topik/astro";
import { createProjectAssetNameGenerator } from "@topik/core";

export const wiki = topikWikiLoader({
  dir: "content/wiki",
  name: "handbook",
  assets: {
    generateName: createProjectAssetNameGenerator({
      projectRoot: "content",
      projectNamespace: "example/handbook",
    }),
  },
});
export const integration = topik({ loaders: [wiki] });
```

These standalone loaders accept the same naming callback as the core compilers;
they do not read a project manifest. `name` identifies the logical loader across
Astro module contexts and does not participate in asset naming. Use a different
loader name for different naming policies applied to the same source directory.
Equivalent instances with the same name, directory, and kind share their current
snapshot. `getAssets()` exposes their descriptors;
`resolveAsset(name)` returns the corresponding `/blobs/<digest>` URL after a
completed load. The integration writes blobs during static builds and serves the
compiled snapshot through middleware in production server builds. Failed loads
clear the current snapshot rather than delivering stale source files.

## File and output constraints

Local files must satisfy the compiler's path, media, and size rules. Paths cannot
escape the compilation directory or collide under normalization or case folding.
The compiler refuses symlinks, hard links, executable or special files, protected
compiler inputs, unsupported media, active content, and files that change during
inspection. An image needs meaningful alternative text; a download needs a
meaningful label.

The CLI stages a complete output generation before replacing the previous one.
Callers must serialize writes to the same output directory. This replacement is
not a cross-process locking, rollback, or crash-recovery mechanism; applications
that need those guarantees must manage generations themselves.

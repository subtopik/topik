---
title: Assets
description: Compile local images and downloads, preserve their identity, and deliver their bytes.
---

# Assets

This page explains how local images and downloads become `Asset` resources: how
to reference a file, how Topik names it, what the compiler writes, and how an
application delivers the bytes. Read it when your Markdown references local
files or your application renders compiled content.

Authors reference local images and downloads in Markdown. During compilation,
Topik discovers the supported files, emits an `Asset` resource for each, and
rewrites the references to `asset:<generated-name>`. Applications deliver the
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

The resolved file must be inside the directory of the local configuration, here
the directory containing `wiki.yaml`. An image needs meaningful alternative
text; a download needs a meaningful label.
[File and output constraints](#file-and-output-constraints) lists which files
the compiler accepts.

The compiler creates assets from:

- Markdown images;
- `figure` light and dark sources;
- local Markdown links that resolve to a supported regular file.

It checks every authored conditional branch. Frontmatter, captions, arbitrary
strings, and card navigation links do not create assets.

Remote files are never compiled into assets:

- A credential-free HTTPS image or download stays an external reference. The
  compiler does not download it or create an asset descriptor for it.
- HTTP URLs and URLs that carry credentials are refused.

## Set a stable project namespace

The generated name of an asset depends on the project namespace. Declare the
namespace in `.topik.yaml`, where it is required:

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

Standalone library calls such as `compileWiki` and `compileGuides` do not read a
manifest. They take an `assets.generateName` callback; see
[Standalone asset naming](#standalone-asset-naming).

## Generated identity

In a project build, an asset has two identities with different uses:

- Its **generated name** identifies the project namespace and the asset's
  manifest-relative path, which is its path relative to the directory containing
  `.topik.yaml`. In the example above the paths are `images/setup.png` and
  `downloads/checklist.pdf`. With the manifest one level above `handbook/`, they
  would include the `handbook/` prefix.
- Its **payload digest** identifies its bytes.

| Change                       | Generated name | Payload digest                    |
| ---------------------------- | -------------- | --------------------------------- |
| Edit a file at the same path | Preserved.     | Changes when its bytes change.    |
| Move a file                  | Changes.       | Preserved if its bytes are equal. |
| Change the project namespace | Changes.       | Preserved if its bytes are equal. |
| Use equal bytes at two paths | Two names.     | One shared payload.               |

Moving a checkout or changing its Git remote preserves generated names.

Within a project, references to the same file share a name, including
references from overlapping Wiki and collection directories. Different
manifest-relative paths produce different names. Independent projects with the
same namespace and matching paths produce the same names, so choose distinct
namespaces deliberately.

Topik owns the derivation. Authors keep ordinary local references in editable
source and do not assign generated names themselves.

A generated name is `auto-v1-` followed by 52 lowercase base32 characters; the
final character is `a` or `q`. The suffix encodes the complete SHA-256 digest of:

```text
UTF8(NFC(project-namespace)) + NUL + UTF8(manifest-relative-asset-path)
```

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

| Output                 | Contents                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset descriptor       | The generated `name`, a `spec.uri` of `blobs/<digest>`, the matching `spec.integrity` of `sha256:<digest>`, the exact byte `size`, and a verified `mediaType`. |
| `blobs/<digest>`       | The payload bytes. Equal bytes are written once per compilation, even when several source locations have separate asset names.                                 |
| `semantic.json`        | Generated names and their declared content occurrences.                                                                                                        |
| `materialization.json` | Resource and payload paths, sizes, and digests.                                                                                                                |

Transfer the inventories together with the descriptors and blobs. A complete
materialization must agree with the resources and content references. An Asset
that passes schema validation on its own is not proof that its bytes are
present or correct.

The CLI stages a complete output generation before it replaces the previous
one. Callers must serialize writes to the same output directory. The
replacement is not a cross-process locking, rollback, or crash-recovery
mechanism; applications that need those guarantees must manage generations
themselves.

### Find an asset's source file

The output never records where an asset came from. A program that calls the
compiler gets that from the result: `assetSourcePaths` maps each generated
local Asset name to the path of its source file, relative to the compilation
directory (the project directory for `compileManifest`), with `/` separators.

```ts
const { payloads, assetSourcePaths } = await compileManifest({ dir: projectRoot });
for (const payload of payloads) {
  const files = payload.assetNames.map((name) => assetSourcePaths[name]);
}
```

Files with equal bytes share one payload and keep separate names, so a payload
can map to several files. An external `https` reference produces no Asset and
has no entry. The map is not part of `semantic.json` or
`materialization.json`, is not written to the output directory and is not sent
to the preview.

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

- The resolver only maps names. The application must also serve the blobs.
- A source-relative path is not a delivery URL.
- A missing or malformed generated reference produces a diagnostic, and the
  renderer omits the unresolved browser-facing URL.
- Resolution applies only to declared asset fields.

### Astro integration

`@topik/astro` is a private workspace package. An application that uses it
passes the same loader instances to its content collections and to the Topik
integration, so that page content and delivery share one compiled snapshot.

Place this example in `topik-loaders.ts` beside `.topik.yaml` at the project root.
The manifest uses `namespace: example/handbook` and declares the Wiki configuration
at `content/wiki/wiki.yaml`:

```ts
import { fileURLToPath } from "node:url";
import { topik, topikWikiLoader } from "@topik/astro";
import { createProjectAssetNameGenerator } from "@topik/core";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export const wiki = topikWikiLoader({
  dir: fileURLToPath(new URL("./content/wiki", import.meta.url)),
  name: "handbook",
  assets: {
    generateName: createProjectAssetNameGenerator({
      projectRoot,
      projectNamespace: "example/handbook",
    }),
  },
});
export const integration = topik({ loaders: [wiki] });
```

Both paths are anchored to the module location. An asset at
`content/wiki/logo.png` keeps that full manifest-relative path for naming, so its
generated name matches the project build regardless of the working directory.

The loaders are standalone: they do not read a project manifest, and they accept
the same naming callback as the core compilers.

- `name` identifies the logical loader across Astro module contexts. It does not
  participate in asset naming. Use a different loader name for each naming
  policy applied to the same source directory.
- Equivalent instances with the same name, directory, and kind share their
  current snapshot.
- `getAssets()` returns the snapshot's descriptors.
- `resolveAsset(name)` returns the corresponding `/blobs/<digest>` URL after a
  completed load.

The integration writes blobs during static builds and serves the compiled
snapshot through middleware in production server builds. A failed load clears
the current snapshot, so the integration never delivers stale source files.

## Standalone asset naming

`compileWiki`, `compileGuides`, and `compileAssetResources` work without a
manifest, so the caller supplies the naming policy as a callback:
`assets.generateName`, or `generateName` directly on `compileAssetResources`.

The callback:

- receives `{ resolvedAssetPath }`, the absolute native file path after
  reference resolution;
- must return a stable canonical `auto-v1-…` name, synchronously or
  asynchronously;
- is called once per distinct asset path in a compilation.

A callback is required only when the compiler finds a local asset. Content
without local assets needs no naming configuration.

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

The helper reads no manifest. It hashes the namespace and the portable path
relative to `projectRoot`, and rejects files outside that root. If those values
match a manifest build, the generated names match too, including for nested
configurations and shared files.

With a custom callback, the caller owns stability and uniqueness across
compilations. Never hash the absolute checkout path if names must survive
relocation. Within a compilation, the compiler validates the returned names and
rejects different paths mapped to the same name. The compiler is also
responsible for file admission, payload hashing, deduplication, content
rewriting, and inventory validation.

## New media destination

A Wiki, collection or Course configuration can choose the directory where
[project edits](./source-writing.md#media) write new media:

```yaml
# docs/wiki.yaml
id: docs
title: Documentation
assets:
  directory: _assets
```

`assets.directory` defaults to `_assets` beside the local configuration. To
override it, give a normalized portable relative directory, for example
`media/uploads`.

- The path is relative to that configuration's directory, never to the process
  working directory.
- Absolute paths, URLs, traversal, case- or Unicode-unsafe spelling, and the
  reserved `.git` and `.topik` paths are rejected.
- The root `.topik.yaml` declares the project namespace and source pointers. It
  has no asset defaults, and configurations inherit nothing from it.
- Configurations in the same directory share `_assets` by default, and each may
  override its destination. A shared directory alone is not a conflict.

The setting only chooses where new media is written. It does not:

- move existing media;
- restrict which local media can be referenced;
- change Asset namespaces;
- relocate the compiled `blobs/` output;
- grant ownership over files already in the directory.

Compilation neither creates the destination nor writes files there, and the
directory need not exist when compiling. When an edit writes new media, the
complete resolved destination and filename must pass the containment, file-type
and collision checks. An existing file is never overwritten or treated as a
directory.

Tools that use the same contract can read the setting:

- The public Wiki and collection parsers return the effective
  `assets.directory`, including the default.
- Manifest compilation exposes each source's resolved manifest-relative
  `assetDirectory` in its provenance.
- `@topik/core` exports `sourceAssetsConfigSchema`, `SourceAssetsConfig` and
  `DEFAULT_ASSET_DIRECTORY`.

## File and output constraints

Local files must satisfy the compiler's path, media, and size rules.

### Paths and file types

A path cannot escape the compilation directory or collide with another path
under normalization or case folding. The compiler refuses:

- symlinks and hard links;
- executable or special files;
- protected compiler inputs;
- unsupported media and active content;
- files that change during inspection;
- inside a Git checkout, files with an effective Git content filter or
  working-tree encoding. See
  [Inside a Git checkout](./manifest.md#inside-a-git-checkout) for what the
  compiler needs from Git.

On macOS and Windows these checks run in the portable mode described in
[Source filesystem safety](./index.md#source-filesystem-safety) unless file
safety is `anchored`. Windows skips the executable-bit and sparse-file checks,
which its file metadata cannot support.

### Media types

The compiler detects media types from file bytes, not extensions. It
recognizes:

| Kind      | Formats                                                    |
| --------- | ---------------------------------------------------------- |
| Images    | PNG, JPEG, GIF, WebP, AVIF, HEIC/HEIF, BMP, TIFF, and ICO. |
| Audio     | MP3, AAC (ADTS), WAV, Ogg, FLAC, and MP4 audio.            |
| Video     | MP4, QuickTime, 3GPP, and WebM.                            |
| Documents | PDF, ZIP, and gzip.                                        |

Each signature is validated beyond its magic bytes. For example, AAC needs two
consistent frame headers, TIFF a first image directory inside the file, and
WebM a complete EBML header whose DocType is `webm`. Text that happens to start
with the same bytes stays a download.

Matroska files that are not WebM, BigTIFF, and other safe bytes, including
plain text, are opaque `application/octet-stream` downloads.

An image slot needs a recognized image type. Browsers do not all display HEIC
or TIFF, and the preview renders only PNG, JPEG, GIF, WebP, and AVIF images.

### Refused content

SVG is active content, so it is refused both as an image and as a download.
Text counts as active content when it:

- starts with an HTML tag;
- contains a script, frame, embed, form, meta, link, base, style, or document
  element;
- contains an event-handler attribute inside a tag;
- contains a `javascript:` URL in an `href` or `src` attribute;
- starts with an `<svg>` element, or contains one with its closing tag.

A document that opens with an `<?xml ...?>` declaration and a root element
other than HTML or SVG, such as a property list, is data when it contains none
of these and names no XHTML or SVG namespace. Other text, such as code with
`Array<string>`, `i<n` comparisons, or prose that mentions `<svg>`, is an
ordinary download.

The compiler also refuses:

- ELF, Mach-O, and PE (Windows) executables;
- scripts that start with an interpreter line such as `#!/bin/sh`;
- WebAssembly modules;
- Git LFS pointer files, which are small files whose first line is a Git LFS
  `version` line. Run `git lfs pull` first.

A refused local file fails compilation with an `AssetCompilationError`. Its
`diagnostics` name the file in `location.path`; their `message` wording is not
a stable surface. When the reader knows why the file was refused, the error has
a stable `reason`, the same set a
[refused configuration read](./manifest.md#errors) reports:

| `reason`                                                                       | The file                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `git-lfs-pointer`                                                              | holds a Git LFS pointer in place of its content.    |
| `git-filtered`, `git-submodule`                                                | has a Git content filter, or is inside a submodule. |
| `symbolic-link`, `hard-linked`, `executable`, `special-file`                   | is not a plain, non-executable file with one link.  |
| `too-large`                                                                    | exceeds the asset size limit.                       |
| `changed-during-read`                                                          | changed while it was read.                          |
| `git-evidence-unavailable`, `git-repository-untrusted`, `platform-unsupported` | could not be checked on this machine.               |

A damaged or unsupported media file, active content and an executable have no
`reason`. So `reason === "git-lfs-pointer"` tells "stored in Git LFS" apart
from "damaged". [Classify a failure](./manifest.md#classify-a-failure) reads
the reason without knowing the error class.

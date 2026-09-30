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

The resolved file must remain inside the compilation directory. Here, compile
`handbook/`, so the compiler can read both the page and its referenced files.
The normalized identities use `images/setup.png` and `downloads/checklist.pdf`,
relative to that compilation directory.

Discovery covers Markdown images, `figure` light/dark sources, and local Markdown
links proven to be supported regular-file downloads. It checks all authored
conditional branches. Frontmatter, captions, arbitrary strings, and card
navigation links do not create assets.

Credential-free HTTPS images and downloads stay external references. The
compiler does not download them or create asset descriptors for them. HTTP and
credential-bearing asset URLs are refused.

## Set a stable source namespace

Asset names depend on a namespace and normalized source path. Use a namespace
that stays constant across recompilations and checkouts of the same content:

```sh
npx topik compile ./handbook --source-namespace handbook-v1 --validate
```

When the option is omitted, the CLI attempts to derive a namespace from the Git
remote and compilation-root path. A namespace is required only when local assets
are discovered. Library callers pass it explicitly:

```ts
import { compileWiki } from "@topik/core";

export async function compileHandbook(dir: string) {
  return compileWiki({ dir, assets: { sourceNamespace: "handbook-v1" } });
}
```

## Generated identity

An asset's generated name identifies its source location. Its payload digest
identifies its bytes. Those identities have different uses:

| Change                       | Generated name | Payload digest                    |
| ---------------------------- | -------------- | --------------------------------- |
| Edit a file at the same path | Preserved.     | Changes when its bytes change.    |
| Move a file                  | Changes.       | Preserved if its bytes are equal. |
| Change the source namespace  | Changes.       | Preserved if its bytes are equal. |
| Use equal bytes at two paths | Two names.     | One shared payload.               |

Generated names use `auto-v1-` followed by 52 lowercase base32 characters; the
final character is `a` or `q`. The suffix encodes the complete SHA-256 digest of:

```text
UTF8(NFC(source-namespace)) + NUL + UTF8(normalized-source-path)
```

Topik owns that derivation. Authors keep ordinary local references in editable
source and do not assign generated names themselves.

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

export const wiki = topikWikiLoader({
  dir: "content/wiki",
  sourceNamespace: "handbook-v1",
});
export const integration = topik({ loaders: [wiki] });
```

Loaders require an explicit namespace. `getAssets()` exposes their descriptors;
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

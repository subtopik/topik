---
title: Assets
---

# Assets

Topik automatically discovers local files used by supported content fields and emits each one as
an independent `Asset/v1` compiled resource. Authors write ordinary relative references in Guide,
WikiPage, and CoursePage content; `Asset` resources are compiler output and are not authoring input.

The compiler inspects only schema-declared locations:

- Markdown images
- `figure` light and dark image sources
- local Markdown links that resolve to a safe regular file and are therefore proven downloads

It does not scan arbitrary strings, frontmatter, captions, labels, unknown attributes, or
navigation-only links. Credential-free external HTTPS references stay unchanged: the compiler does
not download them, rewrite them, or synthesize Asset resources for them. HTTP references and unsafe
HTTPS forms, including URLs with credentials, fail visibly.

## Generated identity

Every generated name has this form:

```text
auto-v1-<52 lowercase base32 characters>
```

The suffix is the complete unpadded RFC 4648 base32 encoding of:

```text
sha256(UTF8(NFC(stable-source-namespace)) + NUL + UTF8(normalized-relative-POSIX-path))
```

The namespace and normalized source path are the complete identity. Editing bytes at the same path
keeps the name. Moving the file changes the name. Equal bytes at different paths produce distinct
Asset resources, and the same path in different namespaces produces distinct names. Repeated uses
of one namespace and path share one Asset resource.

The CLI derives a stable namespace from the Git remote and compilation-root path when possible.
Use `--source-namespace` when no stable Git identity is available. A namespace is required only when
automatic discovery finds a local file.

## Compiled output

Compiled content refers to generated resources with `asset:<generated-name>`. The emitted descriptor
contains only facts proven from the local bytes:

```yaml
apiVersion: v1
type: Asset
name: auto-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
spec:
  uri: assets/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  integrity: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  size: 48123
  mediaType: application/pdf
```

The published schema is `https://topik.dev/schemas/asset/v1.json`. It is closed and requires the
generated name, canonical payload path, full SHA-256 integrity, verified size, and byte-sniffed media
type. The digest in the payload path and the integrity value must be identical.

Discovery runs once after the complete content resource set is known. Multiple Guides, all pages in
a Wiki, CoursePages, and mixed resource kinds therefore share one Asset set. Descriptors remain
distinct by source identity, while equal payload bytes are written once per compilation digest:

```text
Asset/<generated-name>.json
assets/sha256/<full-lowercase-sha256>
```

The semantic inventory records generated names and their schema-declared content occurrences. The
materialization inventory records every resource descriptor and payload path with its exact size and
SHA-256 digest.

## Rendering

Pass a resolver when rendering compiled content:

```tsx
<TopikContent content={content} resolveAsset={(name) => assetUrls.get(name)} />
```

Resolution is limited to declared Asset-capable fields. Missing or malformed generated names report
a typed diagnostic and omit the browser-facing attribute instead of emitting an unresolved
`asset:` URL.

## Safety

Local references must use canonical compilation-relative POSIX paths. The compiler rejects escapes,
absolute paths, separator aliases, unsafe Unicode, normalization or case collisions, parent/file
collisions, and protected compiler inputs.

Reads are anchored to proven directory and file identities. Symlinks, hard links, Git links and
submodules, special files, executables, changed-during-read bytes, unsupported Git LFS pointers,
filters, working-tree encodings, active content, and unsupported media fail closed. Diagnostics use
safe relative locations and never expose absolute paths, URI secrets, or file bytes.

Compilation output is staged as a complete deterministic generation and published atomically.
Identity changes to the output path, its parents, staged files, the prior generation, or the publish
pointer stop publication without modifying a newcomer.

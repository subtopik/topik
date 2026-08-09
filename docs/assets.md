---
title: Named assets
---

# Named assets

An `Asset/v1` resource gives bytes a stable logical name. Content refers to that name as
`asset:<name>`, and a consumer supplies a resolver that maps the name to a usable URL. The resource
schema is published at `https://topik.dev/schemas/asset/v1.json`.

An explicit name is a lowercase DNS label of at most 63 characters, such as `company-logo` or
`installation-manual`. It remains the same when the Asset's URI changes, its bytes change, or both
change. Integrity identifies one exact revision; it is not the logical identity.

```yaml
apiVersion: v1
type: Asset
name: company-logo
spec:
  uri: media/logo.png
  license:
    spdxExpression: CC-BY-4.0
  attribution:
    text: Example attribution
```

Place explicit descriptors below the compilation root's `assets/` directory as `.json`, `.yaml`, or
`.yml` files. Files are read in canonical path order. Each `spec.uri` is relative to the compilation
root, not to the descriptor. Asset declarations may also be supplied through the compiler API, and
standalone declarations are retained even when no content refers to them. Names are unique across
the complete compilation.

For local input, `integrity`, `size`, and `mediaType` are optional. Compilation reads the bytes and
derives all three, while rejecting a supplied value that differs. The compiled resource uses
`sha256:<64 lowercase hexadecimal characters>`, a non-negative byte size, and the media type proven
from the bytes.

Remote input uses a credential-free immutable HTTPS URL. It must supply integrity, size, and media
type because compilation does not fetch it. User information, queries, fragments, and signed or
expiring URL forms are rejected. Both local and remote Assets are limited to 256 MiB. Remote Assets
keep their HTTPS URI and produce no local payload.

## Implicit names

A supported local image or proven download may be written as a relative path in source content.
Compilation creates one implicit Asset and rewrites the compiled content to `asset:<generated-name>`.
The generated form is `auto-v1-` followed by 52 lowercase unpadded RFC 4648 base32 characters. It is
the full SHA-256 of:

```text
UTF8(NFC(stable source namespace)) + NUL + UTF8(normalized compilation-relative POSIX path)
```

The byte digest is deliberately absent from this name. Editing a file in place keeps its name;
moving it creates a new name. Equal bytes at different paths remain distinct Assets, while repeated
references to the same namespace and path reuse one Asset.

Source-relative `.` and `..` segments are resolved against the content source before the resulting
compilation-root-relative path is validated. An in-root parent reference is therefore supported,
while any traversal outside the root still fails.

Compiler callers provide `assets.sourceNamespace` only when implicit local references occur. The
namespace is normalized to NFC before forbidden-character and 1024-byte checks, so canonically
equivalent input produces the same generated name. The CLI accepts `--source-namespace`. If
omitted, it derives a reproducible namespace from a stable Git
remote identity and the compilation root's worktree-relative path. Branch, commit, checkout path,
and machine path do not participate. When no stable Git identity exists, use the option explicitly.
Explicit-only compilations need no namespace.

The compiler inspects only Asset-capable slots declared by the content schema: Markdown image
sources and declared component image/download attributes. It does not scan arbitrary attributes,
frontmatter, code, captions, titles, labels, or unrelated links. A plain local link becomes a
download only when the application declares that occurrence or compilation proves it targets a
regular non-resource file. Ordinary navigation and external HTTPS references remain unchanged.
Compiler configuration, resource content, and explicit Asset descriptor sources are protected and
cannot become Asset payloads. Named Assets used by image roles must declare an image media type;
download roles may use safe opaque and document types. Navigation-only card targets reject
`asset:` URLs.

## Shared compilation and output

Asset discovery happens after all Guide, WikiPage, and CoursePage content is known. Resolution then
runs once against one compilation-wide name set. Several resources can therefore refer to one
explicit Asset, and local references to the same implicit namespace/path reuse one generated Asset.
Containers do not own or duplicate payloads.

The compiler emits resource descriptors only as canonical JSON in one self-contained tree:

```text
Asset/<name>.json
Guide/<name>.json
WikiPage/<name>.json
assets/sha256/<full-sha256>
.topik/materialization.json
.topik/semantic.json
```

Compiled local Asset descriptors point to `assets/sha256/<full-sha256>`. Each unique byte payload is
written once even when several Asset names use it. Resource and payload inventories use canonical
ordering. Writes stage a complete replacement, prune stale output, and retain the prior tree if a
replacement cannot complete. Existing populated output is replaceable only when its identity files
prove compiler ownership; source directories, source ancestors, and unowned populated directories
are never replacement targets. The output path is a compiler-owned relative pointer to a complete
sibling generation. Renaming that pointer is the one visibility transition, so concurrent readers
observe either the complete old generation or the complete new generation without requiring an
external atomic-exchange utility. Initial publication is a conditional symlink creation.
Replacement rechecks the exact open generation and prior pointer immediately before a non-yielding
atomic transition; a changed generation or output name fails without publishing or replacing the
newcomer. Superseded generations are retained outside the live pointer so cleanup cannot delete a
path that changes after ownership proof; callers may archive them through a separate explicitly
scoped process. Compiler-created publish, failed-generation, and file-staging directories are
likewise descriptor-anchored and retained rather than recursively deleting a replaced pathname. A
legacy real-directory output is left untouched and must be moved aside explicitly before adopting
the pointer layout. Dry-run output reports both resource descriptors and payloads.

Semantic identity records Asset names and their exact content-reference mappings. Exact
materialization identity records the path, byte size, and SHA-256 of every canonical JSON resource
descriptor and deduplicated payload. A byte change preserves explicit and same-path implicit
identity while changing exact materialization. Omitting a required Asset descriptor or payload
invalidates the inventory. Exported validation requires the known record version, canonical unique
paths, exact sizes and SHA-256 values, and one descriptor for every compiled resource, including
non-Asset resources. Unknown inputs must be complete prototype-safe own-data graphs; accessors,
custom prototypes, and malformed descriptor types are schema-invalid without executing supplied
getters.

At render time, `@topik/content-react` accepts a named resolver:

```tsx
<TopikContent content={content} resolveAsset={(name) => assetUrls.get(name)} />
```

Resolution is limited to declared `asset:<name>` slots. A missing or malformed name reports a typed
diagnostic and omits the browser-facing attribute instead of emitting an unresolved `asset:` URL.

## Migration from 16-character digest names

`migrateLegacyDigestOutput` upgrades the earlier compiler output that used 16 hexadecimal Asset
names, SRI-style base64 integrity, content references to those names, and `spec.assets` arrays. The
caller supplies the stable source namespace and source root. Input can be the actual set of separate
`.json`, `.jsonl`, `.yaml`, or `.yml` legacy resource files; successful migration returns an exact
path-and-byte backup of the complete input set. Migration verifies each local file and
old integrity, derives the new path-based name and exact facts, rewrites only declared content
slots, and removes obsolete arrays. An absent `spec.assets` on an asset-free Guide or WikiPage is
treated as an empty legacy list and remains absent. Absent and empty lists are accepted only when
content has no local or canonical Asset-capable image or figure occurrence. Markdown links with an
extension treated as a download by the earlier compiler are also Asset-capable, including encoded,
query, and fragment spellings, while ordinary Markdown navigation remains navigation. Nonempty
lists must reconcile every Asset-capable occurrence before migration can succeed.

Migration is all-or-nothing. Missing, malformed, remote, colliding, partially referenced, or
ambiguous input fails without producing a partial result, and retrying with the same input is
deterministic.

## Security and portability limits

Paths must already be normalized compilation-relative POSIX paths. Absolute paths, traversal,
separator and percent-encoding aliases, controls, bidi characters, non-NFC storage spellings,
casefold/NFC collisions, and parent/file collisions are rejected. The path contract limits a
component to 255 UTF-8 bytes, a path to 64 components, and a bound repository path to 768 bytes.

Local reads are anchored to open directory descriptors and reject symlinks, hard links, Git links,
special files, executables, changed-during-read files, Git LFS pointers, filters, and working-tree
encodings. Compiler configuration and content inputs also reject symlinked files or path ancestors,
including aliases whose targets remain inside the compilation root. Effective Git attributes
include ancestors from the worktree boundary, repository
`info/attributes`, and configured global/system attributes; evidence is checked before and after
the byte read, and every effective transform fails closed. An Asset is limited to 256 MiB; a
descriptor is limited to 1 MiB; a compilation accepts
at most 10,000 Assets. Media inspection derives the type from bytes and recognizes active HTML,
SVG, XML, script, WebAssembly, and executable forms behind bounded padding. Inspection completes a
partial UTF-8 code point at the 64 KiB boundary or fails closed. Active local bytes are rejected by
default; an explicit download-only policy may allow them, and servers must then force attachment
delivery and `X-Content-Type-Options: nosniff`.

Diagnostics expose stable IDs and safe relative locations without copying untrusted references,
absolute machine paths, traversal spellings, URI paths, or bytes.
Canonical Asset JSON uses deterministic recursive key ordering, normalized JSON scalars, LF, and
one final newline. Parsing rejects duplicate members, inherited properties, unsupported versions,
unknown fields, invalid UTF-8, and noncanonical persisted bytes. Behavior-defining source-reference
and license-expression parsers are exact-version runtime dependencies.

## Release status

This repository change and its current package version do not constitute a package release or claim
same-line conformance. A future coordinated package release must verify packed exports, exact
versions, provenance, and fixture evidence.

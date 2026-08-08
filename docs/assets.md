---
title: Portable assets
---

# Portable assets

Portable assets use one canonical JSON sidecar at `.topik/assets.json`, relative to the exact
resource root. The persisted identity is `AssetManifest/v1`, whose immutable schema ID is
`https://topik.dev/schemas/asset-manifest/v1.json`. The behavior descriptors are
`topik-json-v1`, `topik-path-v1`, and `topik-asset-reference-v1`. The sidecar binds exactly one
resource through its `(type, apiVersion, name, path)` tuple.

Content names local assets with canonical resource-root-relative URI paths, for example
`assets/intro/hero.png`. Source references must already use that root-relative spelling: the compiler
rejects leading `/`, `./`, `../`, encoded separators or traversal, and other noncanonical forms
instead of normalizing or rewriting them. Non-unreserved UTF-8 bytes use uppercase percent encoding.
A conforming checkout or extracted portable archive therefore remains renderable offline without a
host service, remote identifiers, delivery URLs, credentials, or network access. An absolute
credential-free HTTPS URL is a distinct external reference: its exact query and fragment are
preserved, it has no sidecar entry, and ordinary consumers never fetch it. Other schemes,
protocol-relative URLs, credentials, and controls are invalid in asset slots.

`@topik/content-schema` declares the Markdoc attributes that are asset slots and extracts every
occurrence independently. It does not scan arbitrary strings. A generic link is a download only
when explicitly declared or when compilation proves that its canonical target is a regular file
which is not another resource or content file; ordinary navigation stays a link, and an explicitly
declared resource link is an ambiguity error. A valid v1 sidecar is complete: every local
occurrence resolves exactly one entry, every entry is referenced, and its regular
non-executable file matches the recorded SHA-256, byte size, and media type verified from bytes.
Symlinks, hard links, submodules, executables, special files, Git LFS pointers/filters,
`working-tree-encoding`, and security-sensitive Git control files are rejected.
Recognizable HTML, script, SVG, WebAssembly, and executable content cannot fall through as an opaque
download, including content behind bounded padding, declarations, and comments. An unresolved active
preamble that exhausts the inspection bound fails closed. Snapshot callers must explicitly opt active
content into a proven download occurrence with `allowActiveDownloads`; any server that supports that
policy must force attachment disposition and disable content sniffing.
Git-tree descriptors use mode `100644`; archive descriptors use `0644`. The filesystem helper
succeeds only on Linux when it can traverse from open directory descriptors through `/proc/self/fd`
with no-follow flags and stable before/after identity. Other platforms receive a visible unsupported
file diagnostic rather than a path-based best effort.

`@topik/core` exports the version constants, consumer-capability declaration, canonical
parser/serializer, path/reference and collision validators, opaque key generator, occurrence/file
snapshot validation, filesystem no-follow reader, and semantic/materialization identity helpers.
Operations return typed results with stable diagnostic IDs, blocking consequences, descriptor
versions, safe locations, and recovery categories. Human wording and diagnostic order are not a
compatibility surface. Diagnostics never contain unsafe references or raw untrusted source; when a
failed result retains exact bytes in `source`, that field is deliberately non-loggable and must not
be copied into diagnostics or telemetry. Each diagnostic has a safe opaque correlation ID; callers
can replace the deterministic library default across an operation with `correlateTopikAssetResult`.
Unknown manifest, serializer, path-rule, and reference-rule versions fail visibly; consumers may
advertise lower deployment limits but may not silently weaken the portable maximum. Manifest
operations accept an optional binding-root context so the complete root-plus-path stays within 768
UTF-8 bytes.

## Direct resource compilation

Guide and WikiPage resources use their portable v1 shapes directly. Their content retains canonical
local paths and does not carry a second asset-name list. `compileGuides`, `compileWiki`, and
`compilePortableResourceArtifacts` produce one `PortableResourceArtifact` for each Guide, WikiPage,
or CoursePage. Asset-free content resources receive an empty manifest; Wiki, Course, and
CourseModule containers receive no artifact and cannot own another resource's files.

Every artifact declares a collision-free `Type/name` resource root, an exact resource binding, the
canonical sidecar bytes, the validated snapshot, semantic identity, exact materialization identity,
and a complete inventory containing:

- `resource.json`, the canonical bound resource descriptor;
- `content.topik`, the exact UTF-8 materialization of the descriptor's content;
- every byte-verified manifest asset at its canonical relative path; and
- `.topik/assets.json`.

The compiler reads assets with the descriptor-anchored no-follow filesystem helper. It derives
SHA-256, size, and media type from the opened bytes, reuses one manifest entry for repeated
occurrences within a resource, and never shares ownership across resources. Opaque keys come from a
CSPRNG. Compilation returns `assetKeyState`; pass it back through the `assets.keyState` option on a
retry to retain exact key assignments. Key history is scoped by resource root, so independent roots
may use the same opaque key text. Removing an assignment retires its key within that resource's
history; a later re-addition cannot reuse it. Tests may inject `assets.randomBytes`, while production
callers normally omit it. Filesystem compilation rejects a symlink supplied as its root and evaluates
applicable root and nested `.gitattributes`; any effective `filter` or `working-tree-encoding` state
other than unspecified blocks portable emission. An explicit `!filter` or
`!working-tree-encoding` resets that attribute to unspecified; an explicit `-` unset remains
non-portable.

The CLI continues to write ordinary resource files under `Type/name.<format>` and writes each exact
portable root under `portable/Type/name/`. This layout allows several logical resources to coexist
without competing for one physical sidecar. Portable output is staged and replaces the previous tree
as a complete inventory, pruning stale files. On Linux, output traversal and writes stay anchored to
open directory descriptors; symlinked ancestors, destination symlinks, hard links, and special nodes
are rejected. Other platforms fail visibly when that proof is unavailable. The development server
exposes proven inventory bytes at `/portable/Type/name/<owned-path>`, sends `nosniff`, forces opaque
and active download types to `attachment`, and never serves an unchecked source path.

## Release status

This repository change and its current package version do **not** claim portable-asset conformance
or constitute a public release. The implementation can ship only in a future coordinated public
Topik package release set with exact package versions, provenance, packed-export checks, and fixture
evidence. No package version or publication tag is changed here.

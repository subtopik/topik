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
`assets/intro/hero.png`. Non-unreserved UTF-8 bytes use uppercase percent encoding. A conforming
checkout or extracted portable archive therefore remains renderable offline without a host service,
remote identifiers, delivery URLs, credentials, or network access. An absolute credential-free HTTPS URL
is a distinct external reference: its exact query and fragment are preserved, it has no sidecar
entry, and ordinary consumers never fetch it. Other schemes, protocol-relative URLs, credentials,
and controls are invalid in asset slots.

`@topik/content-schema` declares the Markdoc attributes that are asset slots and extracts every
occurrence independently. It does not scan arbitrary strings. A valid v1 sidecar is complete: every
local occurrence resolves exactly one entry, every entry is referenced, and its regular
non-executable file matches the recorded SHA-256, byte size, and media type verified from bytes.
Symlinks, hard links, submodules, executables, special files, Git LFS pointers/filters,
`working-tree-encoding`, and security-sensitive Git control files are rejected.
Git-tree descriptors use mode `100644`; archive descriptors use `0644`. The filesystem helper
succeeds only on Linux when it can traverse from open directory descriptors through `/proc/self/fd`
with no-follow flags and stable before/after identity. Other platforms receive a visible unsupported
file diagnostic rather than a path-based best effort.

`@topik/core` exports the version constants, consumer-capability declaration, canonical
parser/serializer, path/reference and collision validators, opaque key generator, occurrence/file
snapshot validation, filesystem no-follow reader, and semantic/materialization identity helpers.
Operations return typed results with stable diagnostic IDs, blocking consequences, descriptor
versions, safe locations, and recovery categories. Human wording and diagnostic order are not a
compatibility surface. Each diagnostic has a safe opaque correlation ID; callers can replace the
deterministic library default across an operation with `correlateTopikAssetResult`. Unknown manifest,
serializer, path-rule, and reference-rule versions fail visibly; consumers may advertise lower
deployment limits but may not silently weaken the portable maximum. Manifest operations accept an
optional binding-root context so the complete root-plus-path stays within 768 UTF-8 bytes.

## Legacy migration and rollback

The existing `Asset/v1`, Guide/WikiPage v1 `spec.assets`, digest-prefix `asset:` locator, and legacy
compiler remain separate and unchanged. Use the explicitly versioned `migrateLegacyAssets` adapter
with exact original content/resource bytes, legacy Asset resources, an immutable byte provider, and
persisted retry state. A successful migration verifies the full bytes, reuses or creates random
portable keys, writes canonical relative references, returns Guide/WikiPage v2 without
`spec.assets`, and returns one canonical sidecar. It never mutates source files.

Keep the returned exact backup until the target has been validated and accepted. Migration fails
instead of guessing when digest-prefix identity, original paths, metadata, accessibility, or bytes
are ambiguous or lost. Retry with the returned state to reproduce the same keys and target bytes;
retired keys are never reused. Rollback restores or appends from the preserved source representation
rather than reinterpreting legacy bytes as portable v1.

## Release status

This repository change and its current package version do **not** claim portable-asset conformance
or constitute a public release. The implementation can ship only in a future coordinated public
Topik package release set with exact package versions, provenance, packed-export checks, and fixture
evidence. No package version or publication tag is changed here.

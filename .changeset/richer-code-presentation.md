---
"@topik/remark-tags": patch
"@topik/content": patch
"@topik/schema": patch
"@topik/core": patch
"@topik/content-react": patch
"@topik/cli": patch
"@topik/codemod": patch
---

Add code presentation through familiar fence attributes, normalized line
selections, source-preserving authoring nodes, and shared plain/rich React rows,
accessible wrapping/folding, noncolor diff meaning and exact full-payload copy.
Parse quoted attributes before Markdown decoding and write lossless opaque suffixes.

Advance content grammar to 0.2.2, retaining FORMAT_VERSION:1 and the existing
resource/Asset protocols. Preserve template composition and all authored branches;
seal source-writeback contexts with the actual content grammar identity. Verify
packed public exports and Guide/Wiki compiler/source round trips.

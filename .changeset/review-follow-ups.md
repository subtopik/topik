---
"@topik/content": patch
"@topik/core": patch
"@topik/cli": patch
---

Follow-ups from the review:

- The parser budget also charges GFM footnote definitions that close, and any lazy line it cannot place, so a document of thousands of footnote definitions followed by paragraphs is refused within seconds instead of after minutes.
- Link diagnostics carry the link's `column`, so two broken links on one line stay apart.
- `topik compile` notes `.topik-compilation-generation-*` and `.topik-compilation-prior-*` directories that an interrupted compile left beside the output.
- `parseTopikByteRange` parses a single `Range: bytes=…` header for hosts that serve payloads; `topik dev` and the Astro integration use it, and the Astro middleware answers ranges in development and production.
- Both source planners order changed paths by UTF-8 bytes, a file that changed while it was read is read again later in the same compilation, and scratch-tree isolation works with Windows paths.

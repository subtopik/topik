---
"@topik/content": patch
"@topik/core": patch
---

`topik dev` and `watch()` recompile only the documents a save changed. The
watcher keeps parsed documents, validation and analysis results and link
rewrites from the previous compilation and reuses those whose text and links
are unchanged, dropping anything a compilation no longer reads. On a project of
2,500 documents a save recompiles in about 4 seconds instead of 18, with
output identical to a fresh compilation.

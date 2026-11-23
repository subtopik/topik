---
"@topik/content": patch
"@topik/remark-tags": patch
---

Publish `@topik/content` and `@topik/remark-tags` as one file per source module
instead of a single bundled `dist/index.mjs`. The public API, the `"."` export
and the declarations are unchanged. A browser app that statically imports a
small utility such as `isTopikGeneratedAssetName` and loads the compiler from a
lazy module no longer pulls micromark, mdast utilities and the tag syntax into
its entry chunk (about 456 kB down to about 8 kB before minification in a Vite
build).

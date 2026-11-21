---
"@topik/content": patch
"@topik/core": patch
---

Harden parser budgets, script-URL detection, read caching and output ownership.

- The `parserSteps` budget now also charges nested lists indented with tabs, lists nested under empty items, and setext headings (`===` or `---` under a paragraph), whose parser cost grew with the square of the document. They are refused with `topik-content-limit` within about two seconds; ordinary documents with headings, task lists, steps and definition lists are unaffected. The tree-depth guard no longer rescans the whole event list after each container closes.
- SVG and HTML sniffing now refuses `javascript:` URLs written with zero-padded character references (`&#0000106;`, `&#x0006A;`), preceded by control characters, or set through `formaction`.
- A file read that fails or throws inside a compile session is no longer cached, and reads with different `fileSafety` options no longer share a cache entry.
- A compile refuses an existing output as `not-owned` only for unsafe entries (links, special files and hard links) and reports other publication failures as they are.

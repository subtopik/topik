---
"@topik/content": patch
"@topik/core": patch
---

Warn about links to position-dependent heading IDs. Generated heading IDs are numbered by occurrence (`details`, `details-1`), so adding or removing an earlier heading with the same title moves a link to another section without breaking it. The compiler now reports `link-fragment-positional` as a warning, even when broken links are errors, for a link, card or `ref://` reference whose fragment targets a generated ID that other headings on the page share. It suggests an explicit `{% #id %}` instead. `TopikHeading` gains an optional `positional: true` for such IDs.

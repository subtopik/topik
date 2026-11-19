---
"@topik/content": patch
"@topik/core": patch
---

Warn about links to position-dependent heading IDs. Generated heading IDs are numbered by occurrence (`details`, `details-1`), so adding or removing an earlier heading with the same title moves a link to another section without breaking it. The compiler now reports `link-fragment-positional` as a warning, even when broken links are errors, for a link, card or `ref://` reference whose fragment targets a generated ID that shares its base with another generated heading ID on the page, even though the IDs differ (`details`, `details-1`). Titles that differ only in punctuation can share a base too (`C++` and `C#` give `c`, `c-1`); headings with an explicit ID don't count. It suggests an explicit `{% #id %}` instead. References resolved through a supplied `referenceTargets` catalogue are not checked for this, because the catalogue lists heading IDs as plain strings. `TopikHeading` gains an optional `positional: true` for such IDs.

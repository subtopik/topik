---
"@topik/content": patch
---

Spell formatted Markdown the way Prettier and Oxfmt do, so a project can run both formatters over the same files without them rewriting each other. Emphasis is written `_a_`, or `*a*` when a letter or digit touches either side, and bold italics `_**a**_`. A horizontal rule is `---`, `***` inside a list item (or `---` when the list's bullet is `*`), and `***` when it opens the document, where `---` would start frontmatter.

Breaking: formatting, `writeDocument` and editor saves now write existing content with these delimiters, so the first format after upgrading rewrites emphasis and rules. The meaning of documents is unchanged.

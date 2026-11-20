---
"@topik/content": patch
---

Spell formatted Markdown the way Prettier and Oxfmt do, so a project can run both formatters over the same files without them rewriting each other. Emphasis is written `_a_`, or `*a*` when a character other than whitespace or punctuation touches either side, and bold italics `_**a**_`. A horizontal rule is `---`, or `***` inside a list item (`---` when the list's bullet is `*`). Two rules keep `***` where Prettier writes `---`, because `---` would change the document: one that opens the document, where it would start frontmatter, and one directly under a paragraph in a tight list item, where it would turn the paragraph into a heading.

Breaking: formatting, `writeDocument` and editor saves now write existing content with these delimiters, so the first format after upgrading rewrites emphasis and rules. The meaning of documents is unchanged.

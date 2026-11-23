---
"@topik/content": patch
---

Stop writing character references for ordinary whitespace next to inline code and other inline nodes. Formatting wrote `line one ends&#xa;`code`` for a line that starts with inline code and `x&#x20;`y`` in a table cell, because whitespace at the end of any text was treated as if Markdown would trim it. Spaces and a single line ending between a text and its neighbour are now written as they are; only whitespace at the edge of a paragraph, table cell or strikethrough, which Markdown does trim, still uses a reference.

---
"@topik/content": patch
"@topik/content-react": patch
---

Follow-ups from review of `kbd`, positional heading links and literal whitespace:

- `link-fragment-positional` also covers a numbered title that a repeated title's numbering can reach. With two `Step` headings, `Step 1` gets `step-1` or `step-2` depending on order, so links to it now warn too.
- Formatting keeps the `&#xa;` reference spelling for whitespace that follows a hard break, as before literal whitespace next to inline nodes.
- Formatting escapes a colon after a footnote reference that starts a heading, as it does in a paragraph. A heading with a line ending is written in setext form, where `[^1]: text` would start a line and read as a definition, so formatting failed.
- In forced-colors mode, the `kbd` key cap border uses `CanvasText`; the override was previously shadowed by the base rule.
- The docs explain escaping the backslash and pipe keys in `kbd`, and the `kbd` description says it holds one key.

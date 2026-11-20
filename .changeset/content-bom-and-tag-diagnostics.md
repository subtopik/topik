---
"@topik/content": patch
"@topik/remark-tags": patch
---

- Source that starts with a byte order mark keeps exact node offsets, so its autolinks and other references validate, format and rewrite as they do without the mark.
- `parseDocument` and `formatDocument` report each attribute problem once, as `validateTopikContent` does.
- A block opener with an unclosed quote, such as `{% callout title="x %}`, reports only `attribute-syntax-invalid`; its closing tag is no longer also reported as mismatched.

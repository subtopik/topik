---
"@topik/content": patch
"@topik/remark-tags": patch
---

Make content diagnostics actionable. Missing, incompatible and control-character
body or condition variables report `topik-variable-*` with the line and variable
path instead of `topik-transform-failed`. Tag syntax errors carry stable IDs
such as `missing-closing`, `missing-opening`, `duplicate-attribute` and
`tag-unterminated` instead of collapsing to `parse-error`, and remark-tags
diagnostics now always include an `id`. Unsupported expressions report a single
`topik-expression-invalid`; raw HTML and comments report
`node-undefined` at the node's line with its type; misplaced heading IDs report
`topik-heading-id-placement`. Configuration errors name the invalid component,
attribute or field, wrap causes, and reject unknown `allowedParents` and
`children.components` names. Custom component rule IDs get fixed per-rule messages.

Breaking: the diagnostic IDs `topik-transform-failed` and `parse-error` are replaced by the specific IDs above. Code that matched on either must match the new IDs.

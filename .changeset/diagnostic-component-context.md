---
"@topik/content": patch
"@topik/remark-tags": patch
"@topik/cli": patch
---

Say which component and attribute a content diagnostic is about. Tag and attribute
diagnostics carry `tag` and `attribute`, and `attribute-undefined`,
`attribute-type-invalid` and `attribute-value-invalid` carry `expected`: the
supported attribute names, the required type, or the allowed enum values from the
component schema. Messages stay fixed and authored attribute values are never
included. `topik lint`, `compile`, `format` and `dev` print the context after the
message, and `topik lint --json` adds `tag`, `attribute`, `option`, `variable` and
`expected` to a diagnostic when it has them. remark-tags sets `tag` on
`tag-undefined` and `tag-placement-invalid`.

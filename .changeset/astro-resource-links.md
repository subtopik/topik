---
"@topik/astro": minor
---

Preserve compiled `ref://` document destinations in Astro loader bodies and add
`createTopikLinkResolver`. Applications supply resource-name collection entries
and route callbacks using slug metadata; the helper preserves queries and
fragments, reports generic unresolved-reference diagnostics, and returns
`undefined` for missing targets or unsafe browser URLs.

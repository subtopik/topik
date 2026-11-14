---
"@topik/remark-tags": patch
"@topik/content": patch
"@topik/schema": patch
"@topik/core": patch
"@topik/content-react": patch
---

Declare `sideEffects` in the package manifests so bundlers can drop unused
modules: `@topik/content-react` keeps only its stylesheets as side effects, and
`@topik/core`, `@topik/content`, `@topik/schema`, and `@topik/remark-tags` have
none.

---
"@topik/remark-tags": patch
"@topik/content": patch
"@topik/schema": patch
"@topik/core": patch
"@topik/content-react": patch
"@topik/cli": patch
"@topik/codemod": patch
---

Add explicit text templates to supported built-in component labels and figure
alt/caption text, and paired template scopes around one fenced code example.
Ordinary quoted properties and unwrapped code remain literal. Templates preserve
unevaluated authoring source, insert scalar reader values as text, and report
malformed scopes, unsupported locations, missing/incompatible values, and controls.

Advance the content schema to `0.2.1` while retaining `FORMAT_VERSION: 1` and keep
the fixed public package cohort aligned. Document the `{%%` literal-opener escape,
source/reader separation, and compatible-reader requirements.

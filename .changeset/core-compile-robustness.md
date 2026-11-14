---
"@topik/core": patch
"@topik/cli": patch
---

Report Guide filename and duplicate-identity problems as located `guide-name-invalid`
and `guide-duplicate` errors, reject invalid UTF-8 in Wiki and Guide pages with
`document-encoding-invalid`, and reject misspelled top-level configuration keys with
`config-field-unknown`. Compile errors now carry the sanitized offending `field`
and, for duplicates, the conflicting `relatedLocation`, which `topik compile` prints.
Manifest source failures keep the failing file's location and the original error as
`cause`. Wiki page reads are bounded so large Wikis no longer exhaust file
descriptors, a navigation path through a regular file reports `file-not-regular`,
and link compilation skips Course pages without a source path instead of crashing.

---
"@topik/cli": patch
---

`topik validate` skips the empty documents a leading, trailing or repeated `---` separator leaves in a YAML file, so such a file no longer fails with "Resource must be an object". An explicit `null` document is still validated.

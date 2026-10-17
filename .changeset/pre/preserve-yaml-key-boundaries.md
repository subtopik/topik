---
"@topik/core": patch
---

Preserve block YAML tags, anchors and explicit-key indicators when inserting or
removing source metadata. Keep the existing line break when deleting the first
field of a compact sequence mapping, so sibling fields and comments retain their
original spelling and indentation.

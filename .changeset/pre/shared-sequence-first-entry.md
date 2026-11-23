---
"@topik/core": patch
---

Authority that admits a configuration list now covers removing its first entry when the list is indented. Removing that entry deletes its leading indentation, which comes before the list's own value range, so reordering Wiki navigation or deleting its first page was refused with `shared-scope-denied` although the documented `navigation` authority was given. Admitting a list now covers each entry's own line, and the meaning check still refuses any change outside the admitted fields.

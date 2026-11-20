---
"@topik/core": patch
---

Write valid YAML for common source styles and keep order and comments on edits.
Replacing a block list written at its key's column (`tags:` then `- a`), filling
an empty value such as `description:`, and deleting the last record of such a
list now produce valid configuration instead of refused plans or a misleading
`config-parse-failed`. Writer output that would not parse now fails as
`source-validation-failed`. Moving a Course page file keeps its place in the
module's `pages` list and its comment. Creating or deleting a Wiki page edits the
navigation list item by item instead of rewriting it, and an admitted
`navigation` field covers those item edits. Appending or removing the last
frontmatter key no longer leaves a blank line before the closing fence, and
inserted frontmatter keys are no longer quoted. Unportable explicit move paths
return `source-path-invalid`, Wiki and Course initialization refuse an intent
title that differs from the resource with `source-intent-mismatch`, and
same-page `#fragment` links resolve to the same encoded hash as other links.
`replaySourceByteEdits`, `verifySharedEdits`, `SourcePlanningError` and
`SourceTreeError` are now exported.

Breaking: the `hash` that `resolveWikiContentHref` and `resolveCourseContentHref`
return for a same-page `#fragment` link is percent-encoded like every other link,
so `#héllo` gives `h%C3%A9llo`. Code that finds the target element by `hash` must
decode it first.

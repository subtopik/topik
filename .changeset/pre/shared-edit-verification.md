---
"@topik/core": patch
---

- `verifySharedEdits` refuses configuration bytes that differ from the inspected base with `source-base-changed`. Before, a concurrent change that kept every edited range intact was accepted.
- `verifySharedEdits` refuses edits that change any configuration value outside the admitted fields, with `shared-scope-denied`. Before, an admitted field's replacement could close its own value and add or change sibling keys or list items.

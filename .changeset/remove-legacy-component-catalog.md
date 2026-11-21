---
"@topik/content": patch
---

Remove the legacy component catalog and the no-op parse options.

Breaking: `topikComponents` and the `TopikComponentDefinition`, `TopikComponentAttributeDefinition` and `TopikComponentName` types are removed from `@topik/content`. Read component definitions from `components`, with the `ComponentDefinition` and `AttributeDefinition` types. The `file` and `location` options of `parseTopikContent`, which had no effect, are removed.

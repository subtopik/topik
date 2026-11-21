---
"@topik/content": patch
"@topik/core": patch
"@topik/codemod": patch
---

Make the `@topik/content` API consistent and remove what nothing uses.

Breaking:

- `validateTopikContent` returns `{ ok, source, diagnostics }`, like `formatTopikContent` and `compileTopikContent`, instead of `{ valid, source, errors }`.
- `rewriteTopikNavigationReferences` returns `source` on success too, like `rewriteTopikAssetOccurrences`.
- `rewriteAssets`, `removeInvalidTopikAssetReferences`, `removeInvalidTopikNavigationReferences`, `assignTopikHeadingIds`, `toTopikContentDiagnostic`, `formatDocument`, `getEffectiveProps` and `topikAssetReferenceSlots` are no longer exported. Rewrite Asset references with `rewriteTopikAssetOccurrences`, admit untrusted source with `validateTopikContent` or `compileTopikContent`, and format with `formatTopikContent`; compiled trees carry heading IDs.
- A question allows one `explanation`, written after its choices (`topik-question-explanation-placement`).
- A presented code block holds at most 10,000 rows, a size a block of short rows can reach within the output budget.

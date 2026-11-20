---
"@topik/core": patch
---

Give source-writer consumers a contract they can map and predict.

- `sourcePlanDiagnosticCategory(code)` returns one coarse category for every diagnostic code (`request`, `mapping`, `version`, `authority`, `scope`, `stale`, `path`, `reference`, `asset`, `unrepresentable`, `validation`, `tree`, `incompatible` or `internal`), so a consumer can map by category and stay correct when codes are added. Compiler `link-…` IDs are `reference`; every other compiler ID is `validation`. Given the diagnostic object, the fallback for an unexpected exception is `internal`.
- `pathCollisions: "refuse"` on `planSourceUpdates`, `initializeSourceProject` and `addSourceToProject` reports `source-path-collision` with the resource and the occupied path where the planner would otherwise append a hash to a derived document path. The default keeps the rename, with unchanged bytes and plan digests.
- `newSourceDocumentPath`, `sourceDocumentPathCandidates`, `initialSourceDocumentPath` and `sourceMediaPath` export the rules the planners use for the paths of new documents and media, for `planSourceUpdates` and for initialization. The planners call the same functions.
- A tree over the file, file-size or total-size limit reports `source-tree-too-large` with `limit`, `count` and `unit`. `source-tree-invalid` covers duplicate, unsafe or colliding paths.

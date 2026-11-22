---
"@topik/core": patch
---

Source planning refuses two more invalid requests with their own diagnostics. Desired resources that give two Course modules, two pages of a module or two Wiki pages one public route are refused with `route-collision`, naming the second resource, instead of the generic `source-validation-failed` with a hint to reinspect the source. Desired navigation that cannot be resolved otherwise is refused with `resource-invalid` rather than reported as an internal failure. New media named without a generated Asset name is refused with `asset-name-invalid` by `planSourceUpdates` and `initializeSourceProject`, instead of `reference-unrepresentable`.

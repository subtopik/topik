---
"@topik/core": patch
---

Export `SourcePlanDiagnosticCode`, the union of codes the source planners raise.
`SourcePlanDiagnostic.code` is typed with it and still accepts any string, since
compiler diagnostic IDs pass through unchanged. The source update and
initialization planners are split into named steps and share one saved-to-current
reference transport; planning results are unchanged.

---
"@topik/core": patch
---

Reading a source project resolves each Wiki's and Course's navigation once rather than once per page, and asset compilation checks source-path bindings with one lookup each, so large wikis and courses compile and plan source updates faster.

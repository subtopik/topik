---
"@topik/core": patch
---

Write-back output is tidier. Removing an entry from a flow list or map also removes the whitespace after its comma, so `[a, b, c]` becomes `[a, c]` instead of `[a,  c]`, and an entry alone on its line no longer leaves a blank line. A Guide tags edit writes `inheritTags: false` only when the collection declares tags, and initialized Guides no longer carry it.

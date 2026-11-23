---
"@topik/core": patch
---

Write-back output is tidier. Removing an entry from a flow list or map also removes the whitespace after its comma, so `[a, b, c]` becomes `[a, c]` instead of `[a,  c]`, and an entry alone on its line no longer leaves a blank line. Guide tags edits and initialized Guides write `inheritTags: false` only when the Guide's tags would otherwise change: when the collection declares tags, or when the Guide repeats a tag.

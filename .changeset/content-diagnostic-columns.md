---
"@topik/content": patch
---

Report a `column` on every content diagnostic that has a source position,
including link, asset, custom-asset, heading-ID and compile-time variable
diagnostics. `topik-write-failed` from formatting and reference rewrites now
names the line and column of the authored node whose meaning would change.
Formatting keeps `<https://…>` and `<person@example.com>` autolinks as written
instead of rewriting them to `[label](destination)`.

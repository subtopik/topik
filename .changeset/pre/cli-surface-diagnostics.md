---
"@topik/cli": patch
"@topik/core": patch
---

Print located content diagnostics when `topik compile` and `topik dev` fail
instead of a bare `Topik command failed.`, and add `--links` to `topik dev`
(core `watch()` accepts `validation` and an `onError` listener that also receives
the initial compile failure). `topik dev` now fails fast when its directory does
not exist, and `topik compile -o ""` is rejected instead of writing to the default
output. `topik validate` names each unreadable or unparseable file in a directory
and keeps validating the rest, accepts a UTF-8 byte order mark in JSON and JSONL,
and reports every schema violation per resource: `validateResources` now enables
Ajv `allErrors` and sets `ValidationError.id` on every error.

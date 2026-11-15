---
"@topik/cli": patch
---

Say clearly that `topik compile` (including `--dry-run`), `topik lint` and `topik dev`
currently require Linux. Their `--help` summaries and the README command table now
state it, and on macOS or Windows they stop with one message naming the requirement
instead of "Configuration file could not be read safely." `topik dev` now exits
instead of serving a preview that can never compile. `topik validate` is unchanged
and works on any platform.

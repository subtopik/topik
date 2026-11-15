---
"@topik/core": patch
"@topik/cli": patch
---

Move the safe output publication behind `topik compile --out-dir` into `@topik/core`
(`publishOutputDirectory`, `removeOutputDirectory`, internal) so the CLI and the Astro
integration share one implementation. `topik compile` behaves as before, except that it now
refuses more often when another process changes the output during publication: an existing
output directory swapped for another one between being inspected and being opened, or
between staging and being moved aside, is refused instead of moved; and removing the
previous output never follows a subdirectory that was replaced by a symbolic link.

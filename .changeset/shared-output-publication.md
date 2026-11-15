---
"@topik/core": patch
"@topik/cli": patch
---

Move the safe output publication behind `topik compile --out-dir` into `@topik/core`
(`publishOutputDirectory`, `removeOutputDirectory`, internal) so the CLI and the Astro
integration share one implementation. `topik compile` behaves as before, except that an
existing output directory is now also refused when it is swapped for another directory
between being inspected and being opened.

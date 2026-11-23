---
"@topik/core": patch
"@topik/cli": patch
---

`topik compile` applies one symbolic-link rule to an output directory inside the project on every platform: links above the project directory are accepted, and a link at or below it is refused. On macOS and Windows, `--out-dir` through a link inside the project wrote outside the project; it is refused. On Linux, a project path given through a link above it, such as a symlinked `/home`, failed with an output collision; it compiles.

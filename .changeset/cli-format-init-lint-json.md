---
"@topik/cli": patch
---

Add `topik init [dir]`, which writes the `.topik.yaml`, `wiki.yaml` and `index.md`
of the "Compile a wiki" example (`--namespace` sets the project namespace) and
never overwrites an existing file, and `topik format [path]`, which formats Topik
Markdown files in place with the `@topik/content` formatter. `--check` lists files
that would change and exits 1. Files that do not compile cleanly are reported and
left untouched. `topik lint --json` prints the diagnostics as one JSON document on
stdout and exits with the same codes.

---
"@topik/core": patch
"@topik/cli": patch
"@topik/codemod": patch
---

Clearer publication results and CLI output:

- `topik compile` succeeds once the new output is in place, even when the previous output it moved aside cannot be removed; it then prints a warning naming the `.topik-compilation-prior-*` directory that remains. A link, special file or hard link inside an existing output is refused as `compilation-output-not-owned`.
- `topik compile` explains an output path it cannot resolve (`compilation-output-scope-unproven`) and an output it cannot write safely (`compilation-output-unsafe`) instead of printing only "Topik command failed."
- `topik lint` counts a missing image or download once for each page that uses it in its text summary, as `--json` does.
- `topik init` and `topik migrate` keep the line endings of an existing `AGENTS.md` when they update its Topik section, and `topik init` removes the directories it created when writing the project fails.
- `topik-codemod mintlify` reads a `docs.json` saved with a byte order mark, removes a partly written `wiki.yaml` when writing it fails, and says when a file argument is a symbolic link.

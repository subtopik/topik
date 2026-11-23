---
"@topik/cli": patch
---

`@topik/cli` ships the guides for its own version in `docs/`. `topik init` writes an `AGENTS.md` that points coding agents to them, and the new `topik migrate`, run in a directory with `.topik.yaml`, brings it up to date after an upgrade: it creates a missing `AGENTS.md` or updates the Topik section of an existing one. Both leave text outside the `<!--TOPIK START-->` and `<!--TOPIK END-->` markers, and a file without that section, as it is. `topik format` skips `AGENTS.md` when it walks a directory.

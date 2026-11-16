---
"@topik/core": patch
---

A guide collection leaves out `AGENTS.md` when it reads the Markdown files in its directory, so the file `topik init` and `topik migrate` write can sit beside a collection. The file was refused before as a guide with an invalid filename.

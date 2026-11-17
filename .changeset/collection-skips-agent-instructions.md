---
"@topik/core": patch
---

A guide collection leaves out `AGENTS.md` when it reads the Markdown files in its directory, so the file `topik init` and `topik migrate` write can sit beside a collection. The file was refused before as a guide with an invalid filename. Breaking: `AGENTS.md` is never a guide. In a `sourceVersion: 1` collection, an `AGENTS.md` whose frontmatter set both `id` and `slug` compiled as a guide before; it is now left out, so rename the file to keep the guide.

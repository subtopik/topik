---
"@topik/core": patch
---

A guide collection can keep its guides in folders. `include` and `exclude` in `collection.yaml` take patterns relative to the configuration, with `*`, `?` and `**`; without them a collection still reads only the Markdown beside the configuration. Folders only organise files: the slug comes from the filename, except that a folder's `index` or `readme` file (in any letter case) takes the folder's name, so `basics/index.md` is the guide `<collection>-basics`. A collection never reads `node_modules`, dot-directories or linked directories.

Breaking: a collection leaves out Markdown named in capitals. Usual repository files such as `AGENTS.md`, `CHANGELOG.md` and `CONTRIBUTING.md` are left out silently, so the `AGENTS.md` that `topik init` and `topik migrate` write can sit beside a collection; any other, such as `FAQ.md`, is left out with a `guide-left-out` warning. Before, such a file failed the compile, or was a guide when its frontmatter set both `id` and `slug` in a `sourceVersion: 1` collection; rename it in lowercase to keep it as a guide. `README.md` beside the configuration stays a guide in that case and is otherwise left out without an error. Source planning accepts a guide at any path its collection reads, and refuses other paths with `source-path-invalid`.

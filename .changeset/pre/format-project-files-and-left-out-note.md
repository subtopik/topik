---
"@topik/cli": patch
"@topik/core": patch
"@topik/content": patch
---

Breaking: `topik format <dir>` on a project directory (one that holds `.topik.yaml`) formats only the Markdown the project's sources read: wiki navigation pages, collection guides and course module pages. A repository `README.md` or other Markdown beside them no longer makes `topik format` fail and is no longer rewritten; name a file as the path to format it. A project page that does not compile cleanly still fails the command, and an invalid manifest or source configuration stops it with the project error. Other directories are walked as before. `@topik/core` exports `listManifestDocuments` for this list.

A collection reports the warning `guide-left-out` for a capital-named Markdown file that its patterns select and that is not a usual repository file, such as `FAQ.md`: the file may be a guide with the wrong name. `AGENTS.md`, `CHANGELOG.md`, `LICENSE.md` and similar files stay silent, `exclude` silences the warning, and it does not fail `topik compile` or `topik lint`. `guide-left-out`, `guide-not-regular-file` and `guide-outside-compilation-root` now print their own messages in the CLI in place of "Content validation failed."

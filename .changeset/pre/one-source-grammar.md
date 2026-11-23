---
"@topik/schema": patch
"@topik/core": patch
---

Read every source with one set of rules. The rules that `sourceVersion: 1` selected now always apply, and `sourceVersion` is gone.

- Collections, Wikis and Courses read frontmatter `id`, `slug`, `title`, `description`, `labels`, `authors`, `tags` and `inheritTags`, Wiki and collection `labels`, collection `persons`, and Wiki page `source` paths. Other frontmatter keys stay in the file and are not interpreted.
- Wiki links resolve one way: relative links and links ending in `.md`, `.mdx` or `.markdown` address source paths, and extensionless root links address public routes.

Breaking:

- `sourceVersion` is removed from Wiki, collection and Course configurations, from the `Wiki` schema's `spec`, and from `resolveWikiNavigation` and `ResolvedWikiNavigation`. A configuration that still names it is read as if it did not.
- A Guide's `authors` must name Persons declared in the project; `reference-list-invalid` is removed, and an invalid author entry fails with `frontmatter-invalid`.
- Frontmatter is parsed with the configuration parser, so YAML anchors, aliases and tags are refused. A page `description` over the schema limit is refused instead of shortened, and an explicit empty `authors` or `tags` list is kept.
- A `README.md` beside a collection's configuration is a Guide when its frontmatter sets both `id` and `slug`.
- The source writer's `optInConfigs` input, the `source-version-required` and `source-version-collision` codes, the `version` diagnostic category, and `SourceDocumentProvenance.sourceVersion` and `lossyMetadata` are removed.

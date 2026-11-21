---
"@topik/core": patch
---

Source planning and configuration fixes:

- Frontmatter that ends its lines with a lone CR is read like LF and CRLF frontmatter instead of being left in the page content.
- A created or moved document whose path differs from an occupied one only by case or Unicode form, such as `guides/Start.md` beside `guides/start.md`, is refused up front with `source-path-collision` naming the resource. A move may still change only the case of its own path.
- A new collection can be initialized beside convention files such as `AGENTS.md` or `CHANGELOG.md`, which the collection leaves out.
- Collections skip Markdown files whose name starts with a dot, such as `.draft.md`, as they skip dot-directories.
- Course modules reject likely misspellings of their keys, such as `descripton`, like the top level of a configuration does.
- An Asset reference context outside the admitted scope, a saved link to a page a new Wiki removes, and links that cannot be preserved get their coded diagnostics (`resource-scope-denied`, `reference-target-removed`, `reference-unrepresentable`) instead of category `internal`.
- Inspecting and planning a source tree no longer depends on a Git repository above the system temporary directory.
- A Wiki or collection found by its conventional file name is parsed like a selected configuration: the same size limit, byte order mark handling, strict JSON and safe YAML.
- A link that is only a query, such as `?tab=1`, resolves to its own page in `resolveWikiContentHref` and `resolveCourseContentHref` even when a folder with the page's name exists.

---
"@topik/core": patch
---

- Two Wiki or Course pages with the same frontmatter `id`, or two Course pages with the same `slug` in one module, fail with `frontmatter-invalid` at the second page, naming the field and the page it conflicts with. Previously the compile failed with `config-invalid` at the configuration file.
- A Wiki page `source` containing `#`, `%`, `?`, `:` or a backslash, or a link `href` that is not a valid URI, such as one with a space or a non-ASCII character, fails with `config-invalid` naming the navigation field. Previously it passed configuration checks and failed later as an asset compilation error with no location.

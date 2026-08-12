---
title: Resources
---

# Resources

Topik resources are JSON or YAML documents with an `apiVersion`, `type`, `name`, and type-specific `spec`. The current schema package includes people, guides, wikis, wiki pages, courses, modules, and course pages. Individual products may support only a subset while Topik is in alpha.

The compiler reads author-friendly files such as `wiki.yaml` and Markdown pages. It automatically
discovers supported local content references across the complete compilation, emits independent
`Asset/v1` resources, rewrites compiled references to `asset:<generated-name>`, and writes each
unique payload once. Renderers resolve generated Asset names only in declared content slots.

---
title: Resources
---

# Resources

Topik resources are JSON or YAML documents with an `apiVersion`, `type`, `name`, and type-specific `spec`. The current schema package includes people, guides, wikis, wiki pages, courses, modules, and course pages. Individual products may support only a subset while Topik is in alpha.

The compiler reads author-friendly files such as `wiki.yaml`, Markdown pages, and explicit
`Asset/v1` descriptors. It resolves one shared named Asset set across the complete compilation,
rewrites supported local content references to `asset:<name>`, and emits each unique local payload
once. Renderers use a scoped named-Asset resolver for declared content slots.

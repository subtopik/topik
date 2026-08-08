---
title: Resources
---

# Resources

Topik resources are JSON or YAML documents with an `apiVersion`, `type`, `name`, and type-specific `spec`. The current schema package includes people, guides, wikis, wiki pages, courses, modules, and course pages. Individual products may support only a subset while Topik is in alpha.

The compiler reads author-friendly files such as `wiki.yaml` and Markdown pages, then emits portable resources plus a resource-scoped `AssetManifest/v1` artifact for every content-bearing resource. Renderers consume canonical relative paths without relying on a host-specific asset resolver.

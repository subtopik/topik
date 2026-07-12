---
title: Resources
---

# Resources

Topik resources are JSON or YAML documents with an `apiVersion`, `type`, `name`, and type-specific `spec`. The current schema package includes assets, people, guides, wikis, wiki pages, courses, modules, and course pages. Individual products may support only a subset while Topik is in alpha.

The Git compiler reads author-friendly files such as `wiki.yaml` and Markdown pages, then emits portable `Wiki`, `WikiPage`, and `Asset` resources. Renderers consume those compiled resources rather than relying on the original repository layout.

---
title: Topik
description: Write portable Markdown, compile resources, and render content in your application.
---

# Topik

Topik is a Markdown content format and a set of libraries for validating,
compiling, and rendering it. You can use it for a single document or organize
many documents into guides, wikis and courses. Applications provide editing, storage,
publishing, and access control.

There are two levels to work with:

- **Content** is the Markdown inside a document, including Topik components,
  variables, and conditions.
- **Resources** describe documents and their relationships. A wiki, its pages,
  and its local assets become separate resources during compilation.

Keep authored Markdown as the editable source. Compiled resources and rendered
content are outputs derived from it.

## Start with your use case

| You want to                                          | Start here                                    |
| ---------------------------------------------------- | --------------------------------------------- |
| Write or validate a Topik document                   | [Content format](./content/content-design.md) |
| Understand links and plain addresses                 | [Links](./content/autolinks.md)               |
| Display content in a React application               | [Rendering](./content/rendering.md)           |
| Compile a directory of documents                     | [Resources](./resources/index.md)             |
| Organize wiki pages and resolve their URLs           | [Navigation](./resources/navigation.md)       |
| Include local images or downloads in compiled output | [Assets](./resources/assets.md)               |

## Choose a package

| Package                | Responsibility                                                         |
| ---------------------- | ---------------------------------------------------------------------- |
| `@topik/content`       | Parse, validate, format, evaluate, and compile individual documents.   |
| `@topik/content-react` | Render content with React, with optional themed and rich components.   |
| `@topik/core`          | Compile wikis, guide collections and courses; validate resources.      |
| `@topik/schema`        | JSON schemas and TypeScript types for resource envelopes.              |
| `@topik/cli`           | Compile, lint, and validate content directories from the command line. |
| `@topik/remark-tags`   | Low-level Markdown tag syntax for remark and micromark integrations.   |

The [content package reference](https://github.com/subtopik/topik/blob/main/packages/content/README.md)
contains API examples and custom component schemas. Most applications should
start with `@topik/content` or `@topik/content-react`; a directory compiler is not
required to render one document.

Topik is alpha software. Keep related Topik packages on matching releases and
review formatting and migration changes when upgrading.

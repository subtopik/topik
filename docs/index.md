---
title: Topik
description: Write portable Markdown, compile resources, and render content in your application.
---

# Topik

Topik is a Markdown content format and a set of libraries for validating,
compiling, and rendering it. You can use it for a single document or organize
many documents into guides, wikis and courses. Topik does not provide editing,
storage, publishing, or access control; your application does.

There are two levels to work with:

- **Content** is the Markdown inside a document, including Topik components,
  variables, and conditions.
- **Resources** describe documents and their relationships. A wiki, its pages,
  and its local assets become separate resources during compilation.

Keep authored Markdown as the editable source. Compiled resources and rendered
content are outputs derived from it.

## Start with your use case

| You want to                                          | Start here                                          |
| ---------------------------------------------------- | --------------------------------------------------- |
| Write or validate a Topik document                   | [Content format](./content/content-design.md)       |
| Understand links and plain addresses                 | [Links](./content/autolinks.md)                     |
| Insert application values into labels and code       | [Templates](./content/templates.md)                 |
| Label, number, fold, or mark rows in code blocks     | [Code presentation](./content/code-presentation.md) |
| Display content in a React application               | [Rendering](./content/rendering.md)                 |
| Compile a directory of documents                     | [Resources](./resources/index.md)                   |
| Organize wiki pages and resolve their URLs           | [Navigation](./resources/navigation.md)             |
| Configure a project's sources in `.topik.yaml`       | [Project manifest](./resources/manifest.md)         |
| Plan reviewed changes to source projects             | [Source writing](./resources/source-writing.md)     |
| Include local images or downloads in compiled output | [Assets](./resources/assets.md)                     |

## Choose a package

| Package                | Responsibility                                                         |
| ---------------------- | ---------------------------------------------------------------------- |
| `@topik/content`       | Parse, validate, format, evaluate, and compile individual documents.   |
| `@topik/content-react` | Render content with React, with optional themed and rich components.   |
| `@topik/core`          | Compile wikis, guide collections and courses; validate resources.      |
| `@topik/schema`        | JSON schemas and TypeScript types for resource envelopes.              |
| `@topik/cli`           | Compile, lint, and validate content directories from the command line. |
| `@topik/codemod`       | Migrate existing content, such as Mintlify components, to Topik.       |
| `@topik/remark-tags`   | Low-level Markdown tag syntax for remark and micromark integrations.   |

Most applications start with `@topik/content` or `@topik/content-react`; you do
not need a directory compiler to render one document. The
[content package reference](https://github.com/subtopik/topik/blob/main/packages/content/README.md)
contains API examples and custom component schemas.

Topik is alpha software. Keep related Topik packages on matching releases and
review formatting and migration changes when upgrading.

---
title: Resources
description: Compile authored files into typed resources and validate the generated output.
---

# Resources

A resource describes a piece of content independently of the application that
stores or displays it. Every resource has `apiVersion`, `type`, `name`, and a
kind-specific `spec`.

For example, this is a valid guide resource in YAML:

```yaml
apiVersion: v1
type: Guide
name: getting-started
spec:
  title: Getting started
  slug: getting-started
  content:
    format: topik
    value: "# Getting started\n\nKeep a **backup**."
```

The same envelope can be represented as JSON. `@topik/schema` provides JSON
schemas and TypeScript types; `@topik/core` validates resource envelopes.

## Source files and compiled resources

Authors normally work with Markdown and a directory configuration. The compiler
produces resources from those files:

| Source                                    | Output                                    |
| ----------------------------------------- | ----------------------------------------- |
| `wiki.yaml` and pages in navigation       | One `Wiki` plus its `WikiPage` resources. |
| `collection.yaml` and root Markdown files | A `Guide` for each Markdown file.         |
| Supported local images and downloads      | Generated `Asset` resources and payloads. |

Configuration can also use `.yml` or `.json`. Markdown inputs may use `.md` or
`.mdx`; the latter extension does not enable executable MDX. Wikis read pages
listed in navigation, including nested paths. Guide collections read Markdown
files directly in their compilation directory, without recursive discovery.

The schema also describes `Person`, `Course`, `CourseModule`, and `CoursePage`.
Those resource types can be supplied by applications, but the file compiler does
not automatically create them from a course or person directory. Schema support
and file-discovery support are separate capabilities.

## Compile a wiki

Create a directory with `wiki.yaml` and `index.md`:

```text
handbook/
  wiki.yaml
  index.md
```

```yaml
id: handbook
title: Handbook
navigation:
  - index
```

Write ordinary [Topik Markdown](../content/content-design.md) in `index.md`.
Then install and run the CLI:

```sh
npm install @topik/cli
npx topik compile ./handbook --validate
npx topik validate ./handbook/.topik/resources
```

`--validate` checks the generated resource envelopes. `topik validate` accepts
resource files or directories containing JSON, JSONL, or YAML. Point it at the
`resources/` directory, which contains the resource envelopes, rather than the
compilation inventories.

Compilation validates source and unresolved internal wiki links by default.
`--dry-run` lists output paths without writing files; `--out-dir` chooses a
separate output directory. Writing compilation output with the current CLI
requires Linux.

Use [Navigation](./navigation.md) to add folders, groups, page links, and routes.
If the source includes local assets, see [Assets](./assets.md) for source
namespaces and delivery.

## Compile a guide collection

A `collection.yaml` identifies the collection:

```yaml
id: tutorials
title: Tutorials
```

Put guide Markdown files beside that configuration and run `topik compile` on
that directory. Each filename supplies a guide slug; the resource name combines
the collection ID and slug. A frontmatter `title` overrides the first heading as
the displayed title. The compiler can process a wiki and collection together
when both configurations are present in one directory.

## Use the compiler as a library

```ts
import { compileWiki, validateResources } from "@topik/core";

const result = await compileWiki({ dir: "./docs" });
const validation = validateResources(result.resources);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
console.log(result.resources.map((resource) => `${resource.type}/${resource.name}`));
```

Use `compileGuides` for a collection or `compile` to discover both supported
configurations. The result contains resources, asset payloads, diagnostics, and
the semantic and materialization inventories. The library returns these in
memory; the CLI writes the complete output tree.

`validateResources` checks resource envelopes, not every filesystem byte or every
possible application relationship. Keep the generated inventories and payloads
with the resources when transferring a compilation. [Assets](./assets.md#compiled-output)
explains that output boundary.

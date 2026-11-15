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

Authors work with Markdown, local configurations, and a [project manifest](./manifest.md). The compiler
produces resources from those files:

| Source                                    | Output                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| `wiki.yaml` and pages in navigation       | One `Wiki` plus its `WikiPage` resources.                  |
| `collection.yaml` and root Markdown files | A `Guide` for each Markdown file.                          |
| `course.yaml` and declared module pages   | A `Course`, its `CourseModule` and `CoursePage` resources. |
| Supported local images and downloads      | Generated `Asset` resources and payloads.                  |

Configuration can also use `.yml` or `.json`. Markdown inputs may use `.md` or
`.mdx`; the latter extension does not enable executable MDX. Wikis read pages
listed in navigation, including nested paths. Guide collections read Markdown
files directly in their compilation directory, without recursive discovery.

Versioned collections and Courses can declare Person records and author
references in their configuration. Courses use an explicit module hierarchy and
declared Markdown paths rather than directory discovery. See [Source writing](./source-writing.md)
for Course source layout, versioned metadata and reviewed project edits.

## Compile a wiki

Create a directory with `.topik.yaml`, `wiki.yaml`, and `index.md`:

```text
handbook/
  .topik.yaml
  wiki.yaml
  index.md
```

Declare the Wiki in `.topik.yaml`:

```yaml
version: 1
namespace: example/handbook
sources:
  - kind: wiki
    config: wiki.yaml
```

Configure `wiki.yaml`:

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
npx topik validate ./handbook/.topik
```

`npx topik init ./handbook` writes exactly these three files (pass `--namespace`
for another project namespace) and refuses to overwrite any existing file.
`npx topik format ./handbook` rewrites the Markdown in the canonical form; with
`--check` it only lists the files that would change.

`--validate` checks the generated resource envelopes. `topik validate` accepts
resource files or directories containing JSON, JSONL, or YAML, and reports each
failing file, resource, and JSON pointer. When walking a directory it skips
`node_modules` and dot-directories, unless one is the path you pass. Given a
compilation output directory, it validates the envelopes under `resources/` and
skips the `materialization.json` and `semantic.json` inventories.

Compilation validates source and unresolved internal wiki links by default.
`--dry-run` lists output paths without writing files; `--out-dir` chooses a
separate output directory, which may already exist if it is empty. A non-empty
directory is replaced only when it holds a previous compilation. Published
directories are mode `0755` and files `0644`, so another user, such as a web
server, can read them. `topik compile`, `topik lint`, `topik format`, `topik dev`
and `topik validate` run on Linux, macOS and Windows. Off Linux, project files are
read and output is published with the weaker
[portable file safety](#source-filesystem-safety), and the CLI prints one notice
saying so; pass `--file-safety anchored` to refuse instead, which exits with a
message naming the Linux requirement.

Use [Navigation](./navigation.md) to add folders, groups, page links, and routes.
If the source includes local assets, see [Assets](./assets.md) for project
namespaces and delivery.

## Compile a guide collection

A `collection.yaml` identifies the collection:

```yaml
id: tutorials
title: Tutorials
```

Put guide Markdown files beside that configuration and declare it in `.topik.yaml`:

```yaml
version: 1
namespace: example/tutorials
sources:
  - kind: collection
    config: collection.yaml
```

Run `topik compile` on the manifest directory. Each filename supplies a guide slug; the resource name combines
the collection ID and slug. A frontmatter `title` overrides the first heading as
the displayed title. The compiler can process a wiki and collection together
when both configurations are listed in the manifest.

Filename-derived slugs must use lowercase letters, digits and single hyphens,
such as `getting-started.md`, and the collection ID, a hyphen and the slug must
fit in 63 characters. Other filenames fail with `guide-name-invalid` at that
file, unless `sourceVersion: 1` frontmatter supplies both `id` and `slug`. Two
files that produce the same Guide identity, such as `intro.md` and `intro.mdx`,
fail with `guide-duplicate`, which names both files.

Markdown inputs must be valid UTF-8; invalid bytes fail with
`document-encoding-invalid` at that file rather than being replaced. Unknown
configuration keys are retained for source tools, but a top-level key that looks
like a misspelling of a known key, such as `navigaton` or `Title`, fails with
`config-field-unknown`. Configuration and frontmatter failures report the
offending field, such as `navigation[2].title`, when one can be identified.

## Use the compiler as a library

```ts
import { compileWiki, validateResources } from "@topik/core";

const result = await compileWiki({ dir: "./docs" });
const validation = validateResources(result.resources);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
console.log(result.resources.map((resource) => `${resource.type}/${resource.name}`));
```

Use `compileGuides` for a standalone collection or `compile` for the sources
declared in `.topik.yaml`. Only explicit standalone operations omit the manifest. The result contains resources, asset payloads, diagnostics, and
the semantic and materialization inventories. The library returns these in
memory; the CLI writes the complete output tree.

`validateResources` checks resource envelopes, not every filesystem byte or every
possible application relationship. Keep the generated inventories and payloads
with the resources when transferring a compilation. [Assets](./assets.md#compiled-output)
explains that output boundary.

### Source filesystem safety

Markdown inputs and conventionally discovered Wiki and Guide collection
configurations must stay within their source directory and be regular files. The compiler checks both
lexical and resolved paths, rejects symlinked source entries, and validates and
reads each file through the same handle.

Canonical aliases above the source directory, such as macOS's `/var` path or a
symlinked `/home`, are accepted on every platform; the source directory itself and
everything below it must not be symlinks. A name the volume stores in another
Unicode normalization form (for example decomposed on macOS HFS+) is accepted;
a name that differs in case is not. A dangling symlink, or a file removed
while the directory is read, is reported like any other non-regular entry.

On Linux, these reads also open every component of the canonical path through
held directory descriptors with no-follow flags. This prevents a directory
replaced with a symlink during traversal from redirecting the read. Linux
requires accessible `/proc/self/fd`; if descriptor traversal is unavailable,
compilation fails with `file-safe-read-unsupported` instead of falling back to
pathname reads.

On macOS, Windows, and other non-Linux systems, the compiler uses portable
pathname checks and verifies the opened file's identity. These checks
reject ordinary traversal and static symlink escapes, but cannot guarantee
containment against malicious concurrent filesystem mutation. Compile from a
trusted workspace; compilation is not a security boundary against another
process that can modify the source tree or its ancestors. Linux's stronger
traversal also does not provide an immutable snapshot of file contents.

[Manifest and explicitly selected configuration files](./manifest.md), Course
configurations, and
[local assets](./assets.md#file-and-output-constraints) retain their separate,
stricter file rules and the
[Git checkout rules](./manifest.md#inside-a-git-checkout). On Linux they use the
same descriptor-anchored traversal. Elsewhere they use the same portable mode
when file safety is `portable` (the default, `DEFAULT_FILE_SAFETY`): each path
component at and below the source directory is inspected without following
links, the opened handle must be the inspected file, the resolved path must equal
the lexical one, and the whole path is inspected again after the read. The same
limitation applies: this is not containment against a process concurrently
mutating the source tree. Two checks are dropped on Windows because its file
metadata cannot support them: executable permission bits (Node synthesizes mode
bits there) and the sparse-file check (NTFS reports no allocation for small files
stored in the file table). With file safety `anchored` (`compile`, `lint` and
`watch` option `fileSafety`, CLI `--file-safety anchored`), these reads fail with
reason `platform-unsupported` off Linux. Link resolution works in both modes: an
extensionless link such as `[Next](./next)` resolves to a declared page when no
file named `next` exists.

Off Linux, `topik compile --out-dir` publishes in the same portable mode: it stages
the complete generation in a sibling temporary directory, verifies it, proves an
existing output is a previous compilation, and renames it into place, refusing a
symlinked or foreign target. Linux keeps its descriptor-anchored publication.
The Astro integration writes its `blobs/` build output through the same code.

## Multi-source projects

The [project manifest](./manifest.md) can select multiple existing Wiki and collection configurations. Each local configuration keeps its own settings and relative content paths.

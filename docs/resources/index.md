---
title: Resources
description: Compile authored files into typed resources and validate the generated output.
---

# Resources

This page explains what a resource is, how to compile source files into
resources with the CLI or the library, how to validate the result, and which
file safety rules apply to the files the compiler reads. Read it when you set up
a Topik project or consume its compiled output.

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

Authors work with Markdown, local configurations, and a
[project manifest](./manifest.md). The compiler produces resources from those
files:

| Source                                    | Output                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| `wiki.yaml` and pages in navigation       | One `Wiki` plus its `WikiPage` resources.                  |
| `collection.yaml` and root Markdown files | A `Guide` for each Markdown file.                          |
| `course.yaml` and declared module pages   | A `Course`, its `CourseModule` and `CoursePage` resources. |
| Supported local images and downloads      | Generated `Asset` resources and payloads.                  |

Each source kind finds its Markdown differently:

- A wiki reads the pages listed in its navigation, including nested paths.
- A guide collection reads the Markdown files directly in its directory. It
  does not search subdirectories, and it leaves out `AGENTS.md`, the
  instructions for coding agents that `topik init` writes. An `AGENTS.md` whose
  frontmatter sets both `id` and `slug` in a `sourceVersion: 1` collection is
  still a guide.
- A course reads the Markdown paths declared in its module hierarchy. It does
  not discover files by directory.

Configuration files can use `.yaml`, `.yml` or `.json`. Markdown inputs can use
`.md` or `.mdx`; the `.mdx` extension does not enable executable MDX.

Versioned collections and Courses can declare Person records and author
references in their configuration. See [Source writing](./source-writing.md)
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

Two commands help with the source files:

- `npx topik init ./handbook` writes exactly these three files and refuses to
  overwrite any existing file. Pass `--namespace` for another project namespace.
- `npx topik format ./handbook` rewrites the Markdown in the canonical form.
  With `--check` it only lists the files that would change.

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

Run `topik compile` on the manifest directory. Each Markdown file becomes one
Guide:

- The filename supplies the guide slug.
- The resource name combines the collection ID and the slug.
- The displayed title is the first heading, unless a frontmatter `title`
  overrides it.

Filename-derived slugs must use lowercase letters, digits and single hyphens,
such as `getting-started.md`, and the collection ID, a hyphen and the slug must
fit in 63 characters. Other filenames fail with `guide-name-invalid` at that
file, unless `sourceVersion: 1` frontmatter supplies both `id` and `slug`. Two
files that produce the same Guide identity, such as `intro.md` and `intro.mdx`,
fail with `guide-duplicate`, which names both files.

## Multi-source projects

The [project manifest](./manifest.md) can list several Wiki and collection
configurations, and the compiler processes them together. Each local
configuration keeps its own settings and relative content paths.

## Compilation options and output

Compilation validates source and unresolved internal wiki links by default.
`topik compile` accepts these options:

| Option                   | Effect                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `--validate`             | Also checks the generated resource envelopes against their schemas.                                          |
| `--dry-run`              | Lists output paths without writing files.                                                                    |
| `--out-dir <dir>`        | Writes the output to a separate directory.                                                                   |
| `--links <policy>`       | Sets how unresolved wiki links and local guide fragments are handled: `error` (default), `warning` or `off`. |
| `--file-safety anchored` | Refuses to run where anchored file access is unavailable (see below).                                        |

An `--out-dir` directory may already exist if it is empty. The CLI replaces a
non-empty directory only when it holds a previous compilation. Published
directories have mode `0755` and files `0644`, so another user, such as a web
server, can read them. [Compiled output](./assets.md#compiled-output) describes
the output tree.

`topik compile`, `topik lint`, `topik format`, `topik dev` and `topik validate`
run on Linux, macOS and Windows. Off Linux, the CLI reads project files and
publishes output with the weaker
[portable file safety](#source-filesystem-safety) and prints one notice saying
so. Pass `--file-safety anchored` to refuse instead; the CLI then exits with a
message naming the Linux requirement.

### Source errors

- Markdown inputs must be valid UTF-8. Invalid bytes fail with
  `document-encoding-invalid` at that file; the compiler does not replace them.
- Unknown configuration keys are retained for source tools. A top-level key that
  looks like a misspelling of a known key, such as `navigaton` or `Title`, fails
  with `config-field-unknown`.
- Configuration and frontmatter failures report the offending field, such as
  `navigation[2].title`, when one can be identified.

## Validate resources

`topik compile --validate` checks the resource envelopes it generates.
`topik validate` checks resources that already exist:

```sh
npx topik validate ./handbook/.topik
```

It accepts resource files or directories containing JSON, JSONL, or YAML, and
reports each failing file, resource, and JSON pointer.

- When walking a directory it skips `node_modules` and dot-directories, unless
  one is the path you pass.
- Given a compilation output directory, it validates the envelopes under
  `resources/` and skips the `materialization.json` and `semantic.json`
  inventories.

### Graph and content checks

By default `topik validate` checks each resource against its schema on its own.
Two opt-in flags add more checks, and both can be combined:

- `--graph` checks the loaded resources as one complete set. Each `type/name`
  must be unique, and each by-name reference in the table below must name a
  resource in the set. Use it on a whole compilation output; a directory that
  holds only part of a project reports every reference to a resource it leaves
  out.
- `--content` checks the `spec.content.value` of each `CoursePage`, `Guide` and
  `WikiPage` whose content format is `topik`, with the same source checks that
  compilation applies, and reports each content error with its line.

| Reference checked by `--graph`                                | Must name          |
| ------------------------------------------------------------- | ------------------ |
| A Wiki navigation `page` entry                                | Its `WikiPage`     |
| A `WikiPage` `spec.wiki`                                      | Its `Wiki`         |
| A `CourseModule` `spec.course`                                | Its `Course`       |
| A `CoursePage` `spec.module`                                  | Its `CourseModule` |
| A `spec.authors` entry of a `Course`, `CoursePage` or `Guide` | A `Person`         |

These problems are reported like schema errors, with the file, resource and
JSON pointer, and make the command exit with status 1.

### JSON report

`--json` prints one JSON document on stdout in place of the human-readable
report. The exit status is the same in both modes: 0 when everything is valid,
1 otherwise, with a one-line summary on stderr. The document has this shape
(version 1):

```json
{
  "version": 1,
  "valid": false,
  "resources": 2,
  "checks": ["schema", "graph"],
  "diagnostics": [
    {
      "check": "graph",
      "id": "reference-unresolved",
      "file": "resources/CoursePage/welcome.json",
      "resource": "CoursePage/welcome",
      "pointer": "/spec/authors/0",
      "message": "must reference a Person in the resource set; Person/alice is missing"
    }
  ]
}
```

`resources` counts the resources that were loaded and validated, and `checks`
lists the checks that ran. Every diagnostic has all six fields:

- `check` is `schema`, `graph` or `content`, or `read` for a file or target
  that could not be read or parsed. For `read`, `resource` and `pointer` are
  `null`, and `file` is `null` when the target itself failed.
- `id` is a stable identifier such as `resource-invalid`, `resource-duplicate`,
  `reference-unresolved`, `content-invalid` or `resource-json-invalid`, or
  `null` when there is none.
- `file`, `resource`, `pointer` and `message` are reduced to the same safe
  labels as the human-readable report.

## Use the compiler as a library

```ts
import { compileWiki, validateResources } from "@topik/core";

const result = await compileWiki({ dir: "./docs" });
const validation = validateResources(result.resources);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
console.log(result.resources.map((resource) => `${resource.type}/${resource.name}`));
```

Choose the entry point by what you compile:

| Function        | Compiles                              | Reads `.topik.yaml` |
| --------------- | ------------------------------------- | ------------------- |
| `compile`       | The sources declared in the manifest. | Yes                 |
| `compileWiki`   | One standalone wiki.                  | No                  |
| `compileGuides` | One standalone guide collection.      | No                  |

The result contains resources, asset payloads, diagnostics, and the semantic
and materialization inventories. The library returns these in memory; the CLI
writes the complete output tree.

Three functions validate resources. All return errors in the same shape:

- `validateResources(resources)` checks resource envelopes. It does not check
  every filesystem byte or every possible application relationship.
- `validateResourceGraph(resources)` adds the `--graph` checks for a complete
  set. Each of its errors also carries the `index` of its resource in the list.
- `validateResourceContent(resources)` adds the `--content` checks.

Keep the generated inventories and payloads with the resources when
transferring a compilation. [Assets](./assets.md#compiled-output) explains that
output boundary.

## Source filesystem safety

The compiler reads only regular files inside the source directory. How firmly
it can enforce that depends on the platform, and compilation is never a
security boundary against another process that can modify the source tree or
its ancestors. Compile from a trusted workspace.

### Rules for source files

Markdown inputs and conventionally discovered Wiki and Guide collection
configurations must be regular files that stay within their source directory.
The compiler checks both the lexical and the resolved path, and reads the same
file it checked.

| Case                                                                                       | Result                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| The source directory, or anything below it, is a symlink                                   | Rejected.                                  |
| A symlink above the source directory, such as macOS's `/var` path or a symlinked `/home`   | Accepted on every platform.                |
| A name the volume stores in another Unicode normalization form, such as decomposed on HFS+ | Accepted.                                  |
| A name that differs in case                                                                | Rejected.                                  |
| A dangling symlink, or a file removed while the directory is read                          | Reported like any other non-regular entry. |

[Manifest and explicitly selected configuration files](./manifest.md), Course
configurations, and [local assets](./assets.md#file-and-output-constraints)
have separate, stricter file rules and the
[Git checkout rules](./manifest.md#inside-a-git-checkout).

### Anchored and portable reads

On Linux the compiler makes **anchored reads**. It opens every component of the
canonical path through held directory descriptors without following links, so a
directory replaced with a symlink during the read cannot redirect it. Anchored
reads require an accessible `/proc/self/fd`. If it is unavailable, compilation
fails with `file-safe-read-unsupported`; the compiler does not fall back to
pathname reads. Anchored reads do not provide an immutable snapshot of file
contents.

On macOS, Windows and other non-Linux systems the compiler makes **portable
reads**. It checks pathnames and verifies the identity of the opened file.
Portable reads reject ordinary traversal and static symlink escapes, but cannot
guarantee containment against a process that mutates the source tree
concurrently.

For manifests, selected configurations, Course configurations and local assets,
a portable read:

- inspects each path component at and below the source directory without
  following links;
- requires the opened handle to be the inspected file;
- requires the resolved path to equal the lexical one;
- inspects the whole path again after the read.

On Windows, two checks do not run because its file metadata cannot support
them: the executable permission bits (Node synthesizes mode bits there) and the
sparse-file check (NTFS reports no allocation for small files stored in the
file table).

### Refuse portable reads

The file safety setting decides whether the weaker portable reads are
acceptable. Set it with the `fileSafety` option of `compile`, `lint` and
`watch`, or with `--file-safety` on the CLI. It has no effect on Linux.

| File safety                                 | Off Linux                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `portable` (default, `DEFAULT_FILE_SAFETY`) | Portable reads.                                                                                                                 |
| `anchored`                                  | Reads of the manifest, selected configurations, Course configurations and local assets fail with reason `platform-unsupported`. |

Link resolution is the same in both modes: an extensionless link such as
`[Next](./next)` resolves to a declared page when no file named `next` exists.

### Publishing output

`topik compile --out-dir` publishes with the same platform split. On Linux,
publication is descriptor-anchored. On other platforms it is portable: the CLI
stages the complete generation in a sibling temporary directory, verifies it,
proves that an existing output is a previous compilation, and renames the new
generation into place. It refuses a symlinked or foreign target. The Astro
integration writes its `blobs/` build output through the same code.

Symbolic links in the output path follow the rule for source files when the
output directory lies inside the project directory, which includes the default
`.topik`:

| Link in the output path                                                | Result                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Above the project directory, such as a symlinked `/home`               | Accepted on every platform.                                     |
| The project directory itself, or a directory between it and the output | Refused on every platform; nothing is written through the link. |

For an output directory outside the project directory the platforms differ.
Linux refuses a link anywhere in the path as you give it, so pass the real
path. macOS and Windows follow links above the output directory, because
system paths such as `/var` and `/tmp` are links there.

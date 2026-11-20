# @topik/cli

The `topik` command creates, formats, compiles, lints, and validates Topik content
directories.

## Install

```sh
npm install @topik/cli@alpha
```

Topik releases are published under the `alpha` tag; `latest` points at an older
release. Install every `@topik/*` package from `alpha` so they match.

## Usage

Create a project, then run the other commands on its directory, which holds a
`.topik.yaml`
[project manifest](https://github.com/subtopik/topik/blob/main/docs/resources/manifest.md):

```sh
npx topik init ./handbook
npx topik format ./handbook
npx topik lint ./handbook
npx topik compile ./handbook --validate
npx topik validate ./handbook/.topik/resources
npx topik dev ./handbook
```

| Command    | Purpose                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `init`     | Create a minimal wiki project: `.topik.yaml`, `wiki.yaml`, `index.md` and `AGENTS.md` (`--namespace`).                                  |
| `migrate`  | Update the Topik section of `AGENTS.md` to the installed CLI version.                                                                   |
| `format`   | Format Topik Markdown files in place (`--check`, `--file-safety`).                                                                      |
| `compile`  | Compile project content into resource files (`--out-dir`/`-o`, `--format`/`-f`, `--dry-run`, `--validate`, `--links`, `--file-safety`). |
| `lint`     | Check source content without writing compiled resources (`--links`, `--json`, `--file-safety`).                                         |
| `validate` | Validate a resource file, directory, or compile output in JSON, JSONL, or YAML against the schemas (`--graph`, `--content`, `--json`).  |
| `dev`      | Start a development server that watches for content changes (`--port`/`-p`, `--allow-origin`, `--links`, `--file-safety`).              |

Every command runs on any platform;
[File safety](#file-safety-on-macos-and-windows) describes how Linux differs from
macOS and Windows. Run `topik <command> --help` for every flag.

Two options are shared by several commands:

- `--links` sets how unresolved wiki links and local guide fragments are handled:
  `error` (default), `warning`, or `off`.
- `--file-safety` sets how project files are read on macOS and Windows: `portable`
  (default) or `anchored`.

## Create a project

`topik init [dir]` writes `.topik.yaml`, `wiki.yaml` and `index.md` for the project
in the
[Compile a wiki](https://github.com/subtopik/topik/blob/main/docs/resources/index.md#compile-a-wiki)
example: namespace `example/handbook`, wiki `handbook`. The default directory is
the current one.

- `init` creates the directory if needed.
- `--namespace` sets another project namespace.
- `init` never overwrites a file. It refuses to run when any of the three files
  already exists.
- `init` also writes [`AGENTS.md`](#instructions-for-coding-agents), which follows
  its own rule because projects often have one already.

## Instructions for coding agents

`AGENTS.md` tells coding agents how to work on Topik content: which commands to
run and where the guides are. Topik owns only the section between the
`<!--TOPIK START-->` and `<!--TOPIK END-->` markers; write your own instructions
outside it.

`topik init` and `topik migrate [dir]` treat the file the same way:

| `AGENTS.md` in the project               | Result                                   |
| ---------------------------------------- | ---------------------------------------- |
| Missing                                  | Created with the Topik section.          |
| Has one marked section                   | The section is replaced; the rest stays. |
| Has no markers, or more than one section | Kept as it is.                           |
| Is a symbolic link or not a regular file | Kept as it is.                           |

Run `topik migrate` after you upgrade `@topik/cli`, so the section matches the
installed version. `migrate` requires `.topik.yaml` in the directory, changes no
project source, and exits 0 when there is nothing to update.

The package contains the guides for its own version in `docs/`. When
`@topik/cli` is a dependency of the project, they are at
`node_modules/@topik/cli/docs`, which is the path the Topik section names.

## Format Markdown

`topik format [path]` rewrites Markdown files with the
[`@topik/content`](https://github.com/subtopik/topik/tree/main/packages/content)
formatter and prints the files it changed. The path is one `.md` or `.mdx` file, or
a directory; the default is the current directory.

- In a project directory, one that holds `.topik.yaml`, `format` formats the
  Markdown files the project's sources read: the pages in a wiki's navigation,
  the guides of a collection and the pages of a course's modules. Other
  Markdown in the directory, such as a repository `README.md`, is left alone.
  An invalid manifest or source configuration stops the command with the same
  error `topik lint` gives.
- In any other directory, `format` finds every `.md` and `.mdx` file below it,
  skipping `node_modules`, dot-directories, symbolic links and `AGENTS.md`.
- A file named as the path is always formatted.

- `--check` writes nothing, prints the files that would change, and exits 1 if
  there are any.
- A file that does not compile cleanly is left untouched and its diagnostics are
  printed. The command then exits 1.
- A file `format` cannot replace safely is left untouched and reported: a
  hard link, a file with executable permission bits, or a file Git applies a
  content filter or working-tree encoding to. The command then exits 1.
- A rewritten file keeps its permission bits.

`format` replaces a file by renaming a complete new copy over it, so the file
never holds partial output. Before the rename, `format` checks that the file holds
the bytes it formatted and has the same identity, size and modification time. If
the check fails, the file is left as it is and reported, and the command exits 1.
This makes a lost edit unlikely but cannot rule it out: an edit saved between the
last check and the rename is overwritten. Do not run `topik format` while an
editor is saving the same files.

## Lint and compile

`topik lint [dir]` checks the project's source content and prints every problem
it finds in one run: errors and warnings in every page, broken links, and missing
or refused images and downloads. `topik compile [dir]` also writes the compiled
resources, to `.topik` in the project directory unless `--out-dir` names another
directory; it stops at the first kind of error it meets. Both exit 1 when there
are errors. `compile --format` accepts only `json`.

`lint` reports what it can judge now, so fixing one problem does not reveal
another that was already there:

- A page whose content has errors is reported once. Links to it are not
  reported as missing, and its sections are checked once its content is valid.
- A source whose configuration, frontmatter or page list cannot be read is
  reported as one error, and the other sources are still checked. Links and
  images are then not checked, since links into the failed source cannot be
  judged.
- An image or download that cannot be compiled is reported once, after the
  pages that use it. Each page is checked up to its first such failure.

A diagnostic names the component and attribute it is about and what the
component accepts there, never the value that was written:

```text
index.md:3:1 error attribute-value-invalid: An attribute has an invalid value. (tag: callout; attribute: variant; expected: info, tip, warning, danger)
```

`lint --json` prints one JSON document on stdout in place of the text diagnostics.
The exit status is the same as without the flag.

```json
{
  "diagnostics": [
    {
      "file": "index.md",
      "line": 3,
      "lines": [3],
      "id": "link-page-not-found",
      "severity": "error",
      "message": "Internal link target page was not found."
    }
  ],
  "errors": 1,
  "warnings": 0
}
```

- `file`, `line` (the first of `lines`) and `column` are omitted when unknown.
- `tag`, `attribute`, `option`, `variable` and `expected` are present when the
  diagnostic has them. `expected` lists what the component schema accepts: the
  allowed values of an attribute, its type, or the supported attribute names.
- `severity` is `debug`, `info`, `warning`, `error` or `critical`.
- `errors` counts the `error` and `critical` diagnostics.
- A source that cannot be read, or an image or download that cannot be
  compiled, is an `error` with empty `lines`. Its `id` is the failure's ID, such
  as `wiki-page-not-found` or `TOPIK_ASSET_FILE_MISSING`. An image or download
  has one entry for each page that uses it, with that page as `file`. Another
  failure has a `file` only when it names one, such as the configuration file;
  the message always says where it is.

A project whose `.topik.yaml` cannot be read cannot be linted at all. Lint prints
the failure on stderr, and with `--json` stdout still holds one report, with a
single error diagnostic that carries the failure's `id` (such as
`manifest-required`) and message and no `file`.

## Validate resources

`topik validate <path>` checks each resource in a file, a directory, or a compile
output directory against its schema. Three flags extend it:

- `--graph` also checks the resources as one complete set: every `type/name` is
  unique and every by-name reference resolves.
- `--content` also checks Topik page content.
- `--json` prints a stable, versioned JSON report on stdout. The exit status is
  the same as without the flag.

`--graph` and `--content` are off by default because a directory may hold only
part of a project. The
[resources guide](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)
documents the checks and the shape of the JSON report.

## Preview while you write

`topik dev [dir]` starts a development server that watches the project for content
changes. It listens on `127.0.0.1` port `50001`; `--port` sets another port. It
accepts browser connections from `https://write.subtopik.com` unless
`--allow-origin` names another origin.

## File safety on macOS and Windows

`compile`, `lint`, `format` and `dev` read project files and publish output. On
Linux they read and replace files through descriptor-anchored traversal: every
path component is opened relative to the project directory, so a component
replaced by a symbolic link is refused. Listing a directory to discover files
is path-based on every platform. macOS and Windows do not provide anchored
traversal, and `--file-safety` selects what the commands do there:

- `portable` (default): the command checks paths and file identity instead, and
  prints one notice. This does not protect against another process changing the
  project while it is read, so use it only on a workspace you trust.
- `anchored`: the command refuses to run. It stops with a message that names the
  Linux requirement and suggests, for example, WSL 2 or a Linux container.

On Linux both values use anchored access.

## Documentation

- [Resources and compilation](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)
- [Content format](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT

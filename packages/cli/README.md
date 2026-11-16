# @topik/cli

The `topik` command creates, formats, compiles, lints, and validates Topik content
directories.

## Install

```sh
npm install @topik/cli
```

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
| `init`     | Create a minimal wiki project: `.topik.yaml`, `wiki.yaml` and `index.md` (`--namespace`).                                               |
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

## Format Markdown

`topik format [path]` rewrites Markdown files with the
[`@topik/content`](https://github.com/subtopik/topik/tree/main/packages/content)
formatter and prints the files it changed. The path is one `.md` or `.mdx` file, or
a directory; the default is the current directory. In a directory, `format` finds
every `.md` and `.mdx` file below it, skipping `node_modules`, dot-directories and
symbolic links.

- `--check` writes nothing, prints the files that would change, and exits 1 if
  there are any.
- A file that does not compile cleanly is left untouched and its diagnostics are
  printed. The command then exits 1.
- A hard-linked file is left untouched and reported. The command then exits 1.
- A rewritten file keeps its permission bits.

`format` replaces a file by renaming a complete new copy over it, so the file
never holds partial output. Before the rename, `format` checks that the file holds
the bytes it formatted and has the same identity, size and modification time. If
the check fails, the file is left as it is and reported, and the command exits 1.
This makes a lost edit unlikely but cannot rule it out: an edit saved between the
last check and the rename is overwritten. Do not run `topik format` while an
editor is saving the same files.

## Lint and compile

`topik lint [dir]` checks the project's source content and prints its diagnostics.
`topik compile [dir]` also writes the compiled resources, to `.topik` in the
project directory unless `--out-dir` names another directory. Both exit 1 when
there are errors. `compile --format` accepts only `json`.

A diagnostic names the component and attribute it is about and what the
component accepts there, never the value that was written:

```text
index.md:3 error attribute-value-invalid: An attribute has an invalid value. (tag: callout; attribute: variant; expected: info, tip, warning, danger)
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

A failure that stops lint before it produces diagnostics, such as a missing
`.topik.yaml`, prints its message on stderr and nothing on stdout.

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

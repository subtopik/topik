# @topik/cli

The `topik` command creates, formats, compiles, lints, and validates Topik content
directories.

## Install

```sh
npm install @topik/cli
```

## Usage

Run the commands on a directory with a `.topik.yaml`
[project manifest](https://github.com/subtopik/topik/blob/main/docs/resources/manifest.md):

```sh
npx topik init ./handbook
npx topik format ./handbook
npx topik lint ./handbook
npx topik compile ./handbook --validate
npx topik validate ./handbook/.topik/resources
npx topik dev ./handbook
```

| Command    | Purpose                                                                                                                                 | Platform |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `init`     | Create a minimal wiki project: `.topik.yaml`, `wiki.yaml` and `index.md` (`--namespace`).                                               | Any      |
| `format`   | Format Topik Markdown files in place (`--check`, `--file-safety`).                                                                      | Any      |
| `compile`  | Compile project content into resource files (`--out-dir`/`-o`, `--format`/`-f`, `--dry-run`, `--validate`, `--links`, `--file-safety`). | Any      |
| `lint`     | Check source content without writing compiled resources (`--links`, `--json`, `--file-safety`).                                         | Any      |
| `validate` | Validate a resource file, directory, or compile output in JSON, JSONL, or YAML against the schemas (`--graph`, `--content`, `--json`).  | Any      |
| `dev`      | Start a development server that watches for content changes (`--port`/`-p`, `--allow-origin`, `--links`, `--file-safety`).              | Any      |

`--links` sets how unresolved wiki links and local guide fragments are handled:
`error` (default), `warning`, or `off`. `--format` accepts only `json`. The dev
server listens on `127.0.0.1` port `50001` by default and accepts browser
connections from `https://write.subtopik.com` unless `--allow-origin` names
another origin.

`topik init [dir]` writes the project from the
[Compile a wiki](https://github.com/subtopik/topik/blob/main/docs/resources/index.md#compile-a-wiki)
example (namespace `example/handbook`, wiki `handbook`), creating the directory if
needed; `--namespace` sets another project namespace. It refuses to run when any of
the three files already exists and never overwrites a file.

`topik format [path]` takes one `.md` or `.mdx` file, or a directory, which it walks
for those files, skipping `node_modules`, dot-directories and symbolic links (the
default is the current directory). It rewrites each file with the
[`@topik/content`](https://github.com/subtopik/topik/tree/main/packages/content)
formatter and prints the files it changed. A file that does not compile cleanly is
left untouched and its diagnostics are printed; the command then exits 1. `--check`
writes nothing, prints the files that would change, and exits 1 if there are any. A
file is replaced by renaming a complete new copy over it, so it never holds partial
output. Before that, format checks that the file still holds the bytes it formatted
and still has the same identity, size and modification time, keeping its permission
bits. This makes a lost edit unlikely but cannot rule it out: an edit saved between
the last check and the rename is overwritten, so do not run `topik format` while an
editor is saving the same files. Hard-linked files are left alone.

`topik lint --json` prints one JSON document on stdout instead of the text
diagnostics, and exits as without the flag (1 when there are errors):

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

`file`, `line` (the first of `lines`) and `column` are omitted when unknown.
`severity` is `debug`, `info`, `warning`, `error` or `critical`; `errors` counts
`error` and `critical`. A failure that stops lint before it produces diagnostics,
such as a missing `.topik.yaml`, prints its message on stderr and nothing on stdout.

`validate --graph` also checks the resources as one complete set (unique
`type/name`, every by-name reference resolves), and `validate --content` checks
Topik page content. Both are off by default because a directory may hold only
part of a project. `validate --json` prints a stable, versioned JSON report on
stdout with the same exit status; the
[resources guide](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)
documents its shape.

Run `topik <command> --help` for every flag. On Linux, `compile`, `lint`, `format`
and `dev` read project files and publish output through descriptor-anchored
traversal. On macOS and Windows that is unavailable, so by default
(`--file-safety portable`) they check paths and file identity instead and print
one notice: this does not protect against another process changing the project
while it is read, so use it only on a workspace you trust. Pass
`--file-safety anchored` to refuse instead; off Linux the command then stops with
a message naming the Linux requirement (for example, use WSL 2 or a Linux
container).

## Documentation

- [Resources and compilation](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)
- [Content format](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT

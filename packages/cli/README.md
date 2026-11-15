# @topik/cli

The `topik` command compiles, lints, and validates Topik content directories.

## Install

```sh
npm install @topik/cli
```

## Usage

Run the commands on a directory with a `.topik.yaml`
[project manifest](https://github.com/subtopik/topik/blob/main/docs/resources/manifest.md):

```sh
npx topik lint ./handbook
npx topik compile ./handbook --validate
npx topik validate ./handbook/.topik/resources
npx topik dev ./handbook
```

| Command    | Purpose                                                                                                                                 | Platform |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `compile`  | Compile project content into resource files (`--out-dir`/`-o`, `--format`/`-f`, `--dry-run`, `--validate`, `--links`, `--file-safety`). | Any      |
| `lint`     | Check source content without writing compiled resources (`--links`, `--file-safety`).                                                   | Any      |
| `validate` | Validate a resource file, directory, or compile output in JSON, JSONL, or YAML against the schemas (`--graph`, `--content`, `--json`).  | Any      |
| `dev`      | Start a development server that watches for content changes (`--port`/`-p`, `--allow-origin`, `--links`, `--file-safety`).              | Any      |

`--links` sets how unresolved wiki links and local guide fragments are handled:
`error` (default), `warning`, or `off`. `--format` accepts only `json`. The dev
server listens on `127.0.0.1` port `50001` by default and accepts browser
connections from `https://write.subtopik.com` unless `--allow-origin` names
another origin.

`validate --graph` also checks the resources as one complete set (unique
`type/name`, every by-name reference resolves), and `validate --content` checks
Topik page content. Both are off by default because a directory may hold only
part of a project. `validate --json` prints a stable, versioned JSON report on
stdout with the same exit status; the
[resources guide](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)
documents its shape.

Run `topik <command> --help` for every flag. On Linux, `compile`, `lint` and
`dev` read project files and publish output through descriptor-anchored
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

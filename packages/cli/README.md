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

| Command    | Purpose                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `compile`  | Compile project content into resource files (`--out-dir`/`-o`, `--format`/`-f`, `--dry-run`, `--validate`, `--links`). |
| `lint`     | Check source content without writing compiled resources (`--links`).                                                   |
| `validate` | Validate a resource file, directory, or compile output in JSON, JSONL, or YAML against the schemas.                    |
| `dev`      | Start a development server that watches for content changes (`--port`/`-p`, `--allow-origin`, `--links`).              |

`--links` sets how unresolved wiki links and local guide fragments are handled:
`error` (default), `warning`, or `off`. `--format` accepts only `json`. The dev
server listens on `127.0.0.1` port `50001` by default and accepts browser
connections from `https://write.subtopik.com` unless `--allow-origin` names
another origin.

Run `topik <command> --help` for every flag. Writing compilation output
currently requires Linux.

## Documentation

- [Resources and compilation](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)
- [Content format](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT

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

| Command    | Purpose                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `compile`  | Compile project content into resource files (`--out-dir`, `--dry-run`). |
| `lint`     | Check source content without writing compiled resources.                |
| `validate` | Validate resource files in JSON, JSONL, or YAML against the schemas.    |
| `dev`      | Start a development server that watches for content changes.            |

Run `topik <command> --help` for every flag. Writing compilation output
currently requires Linux.

## Documentation

- [Resources and compilation](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)
- [Content format](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT

# @topik/codemod

The `topik-codemod` command migrates existing documentation to Topik Markdown.
It currently converts supported Mintlify MDX components to Topik content tags.

## Install

```sh
npm install --save-dev @topik/codemod
```

## Usage

Preview the changes first, then convert the directory in place:

```sh
npx topik-codemod mintlify ./docs --dry-run
npx topik-codemod mintlify ./docs
```

Converted `.mdx` files are renamed to `.md` unless you pass `--keep-extension`.
Run `topik-codemod mintlify --help` for every flag, and review the result with
`topik lint` from [`@topik/cli`](https://github.com/subtopik/topik/tree/main/packages/cli).

## Documentation

- [Content format](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT

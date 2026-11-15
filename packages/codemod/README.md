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

## Supported components

| Mintlify                                                        | Topik                     | Notes                                                                               |
| --------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `<Note>`, `<Info>`, `<Tip>`, `<Check>`, `<Warning>`, `<Danger>` | `callout`                 | `variant` is `info`, `info`, `tip`, `tip`, `warning` or `danger`.                   |
| `<Card>`                                                        | `card`                    |                                                                                     |
| `<CardGroup>`                                                   | `cardGrid`                | `cols` becomes `columns`.                                                           |
| `<Tabs>`, `<Tab>`                                               | `tabs`, `tab`             | `icon` on a tab is dropped with a warning.                                          |
| `<Steps>`, `<Step>`                                             | `steps`, `step`           | `icon` on a step is dropped with a warning.                                         |
| `<Accordion>`                                                   | `accordion`               | `defaultOpen` becomes `open`; `icon` is dropped with a warning.                     |
| `<CodeGroup>`                                                   | `codeGroup` and `codeTab` | Each fence becomes a code tab titled by the text after its language, such as `npm`. |

Attributes can be quoted strings, literal numbers and booleans (`cols={2}`,
`defaultOpen={false}`) or boolean shorthand (`defaultOpen`). Indented bodies,
including those under multi-line opening tags, are dedented, and LF, CRLF and CR
line endings are kept.

The codemod never guesses. It keeps a file unchanged and reports a warning for
other components (such as `<Frame>`, `<AccordionGroup>` or `<Icon>`), dynamic
attributes, MDX imports, exports and expressions, mismatched closing tags, and
components inside tables, headings, lists, blockquotes or paragraph text. Files are
matched by extension case-insensitively; symbolic links are reported and not followed.

## Documentation

- [Content format](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT

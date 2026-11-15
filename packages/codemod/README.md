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

`--diff` prints a unified diff of every change and writes nothing. Only the patch
goes to standard output, with the per-file summary on standard error, so you can
save it with `npx topik-codemod mintlify ./docs --diff > migration.patch`.

Pass a single `.md` or `.mdx` file instead of a directory to convert just that
page. Other pages are not inspected, so they may link to it, and the file keeps
its `.mdx` extension. Run the codemod on the directory to rename it.

## Navigation

When the directory contains a Mintlify `docs.json`, or a legacy `mint.json`, the
codemod also writes a Topik `wiki.yaml` beside it, so the directory compiles as a
wiki. It never replaces an existing `wiki.yaml`, `wiki.yml` or `wiki.json`, and
reads `docs.json` when both Mintlify files exist.

| Mintlify                                        | Topik `wiki.yaml`                              |
| ----------------------------------------------- | ---------------------------------------------- |
| `name`                                          | `title`, and `id` as a lowercase hyphenated id |
| `description`                                   | `description`                                  |
| `groups`, `{ "group", "pages" }`, nested groups | `type: group` with `children`                  |
| A page reference such as `"guides/setup"`       | The same page path                             |
| `tabs`, with `groups` or `pages`                | `type: tab` with `children`                    |
| `dropdowns`, with `groups` or `pages`           | `type: dropdown` with `children`               |
| A tab or dropdown with an external `href`       | An external tab or dropdown                    |
| `expanded` (groups), `hidden`                   | `expanded`, `hidden`                           |
| Legacy `mint.json` `navigation` groups          | `type: group` with `children`                  |

Groups, tabs and dropdowns get no `slug`, so every page keeps its Mintlify path
and route. Everything else is reported as a warning against the configuration
and left out, including anchors, `global`, versions, languages, products, menus,
OpenAPI entries, icons, group tags and roots, legacy `mint.json` tabs and anchors,
page references that are not lowercase Topik paths or have no `.md` or `.mdx`
file, and repeated routes. Mintlify levels that mix tabs or dropdowns with groups
keep the first kind and report the rest, because Topik allows one navigation
surface per level.

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

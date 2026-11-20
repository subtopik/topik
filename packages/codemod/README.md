# @topik/codemod

The `topik-codemod` command migrates Mintlify documentation to Topik Markdown. It
converts supported Mintlify MDX components to Topik content tags and Mintlify
navigation to a Topik `wiki.yaml`.

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

Run `topik-codemod mintlify --help` for every flag.

Review the result with `topik lint` from
[`@topik/cli`](https://github.com/subtopik/topik/tree/main/packages/cli). It
needs a project manifest, which the codemod does not write; the codemod prints
a reminder when it writes a `wiki.yaml`. Create `.topik.yaml` beside the `docs`
directory, pointing at the generated `wiki.yaml` (see
[Navigation](#navigation)), and run `topik lint` there:

```yaml
version: 1
namespace: example/documentation
sources:
  - kind: wiki
    config: docs/wiki.yaml
```

The path is a directory or a single `.md` or `.mdx` file; the default is the
current directory. In a directory, the codemod converts every `.md` and `.mdx`
file below it, matching the extension case-insensitively. It skips `node_modules`
and names that start with a dot. It does not follow symbolic links inside the
directory, and reports the pages and directories they hide.

### Renamed files

The codemod renames `.mdx` files to `.md` and updates the links to them. Pass
`--keep-extension` to keep the `.mdx` names.

- Every file keeps its `.mdx` extension while any file is left unchanged with a
  warning or an error, or a symbolic link is skipped, because those pages may
  link to the renamed ones. Fix the reported files and run the codemod again to
  rename them.
- A file whose `.md` name is already taken is not renamed, and the codemod
  reports an error for it.

### Save the changes as a patch

`--diff` prints a unified diff of every change and writes nothing. The patch goes
to standard output and the per-file summary to standard error, so you can save
the patch and apply it later:

```sh
npx topik-codemod mintlify ./docs --diff > migration.patch
git apply --directory=docs migration.patch
```

Paths in the patch are relative to the directory you converted. In a Git
repository, run `git apply` from the repository root and give `--directory`
that directory's path: `--directory=site/docs` for `site/docs`. Git skips patch
paths outside the directory it runs in without an error, so the command applies
nothing from an unrelated subdirectory, and plain `git apply` applies nothing
from inside the converted directory. Outside a repository, `--directory` is
relative to the current directory.

The patch uses git headers, so renames from `.mdx` to `.md` apply too. It keeps
CRLF line endings.

### Convert one file

Pass a `.md` or `.mdx` file to convert only that page:

- The file keeps its `.mdx` extension, because the codemod does not inspect the
  other pages, which may link to it. Run the codemod on the directory to rename
  it.
- The file argument must not be a symbolic link. A directory argument may be
  one.

## Navigation

When the directory contains a Mintlify `docs.json` or a legacy `mint.json`, the
codemod also writes a Topik `wiki.yaml` beside it, so the directory compiles as a
wiki.

- When both Mintlify files exist, the codemod reads `docs.json`.
- The codemod never replaces a wiki configuration: when the directory already has
  a `wiki.yaml`, `wiki.yml` or `wiki.json`, it writes nothing.

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
and route.

The codemod reports everything else as a warning against the configuration and
leaves it out of `wiki.yaml`:

- anchors, `global`, versions, languages, products, menus and OpenAPI entries
- icons, group tags and roots
- legacy `mint.json` tabs and anchors
- page references that are not lowercase Topik paths, or that have no `.md` or
  `.mdx` file
- repeated routes

Topik allows one navigation surface per level. Where a Mintlify level mixes tabs
or dropdowns with groups, the codemod keeps the first kind and reports the rest.

## Supported components

| Mintlify                                                        | Topik                     | Notes                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Note>`, `<Info>`, `<Tip>`, `<Check>`, `<Warning>`, `<Danger>` | `callout`                 | `variant` is `info`, `info`, `tip`, `tip`, `warning` or `danger`.                                                                                    |
| `<Card>`                                                        | `card`                    |                                                                                                                                                      |
| `<CardGroup>`, `<Columns>`, `<Column>`                          | `columns`, `column`       | `cols` becomes `count`. Other content between cards is wrapped in a `column`, with a note. A `className` keeps the page unchanged for manual review. |
| `<Tabs>`, `<Tab>`                                               | `tabs`, `tab`             | `icon` on a tab is dropped with a warning.                                                                                                           |
| `<Steps>`, `<Step>`                                             | `steps`, `step`           | `icon` on a step is dropped with a warning.                                                                                                          |
| `<Accordion>`                                                   | `accordion`               | `defaultOpen` becomes `open`; `icon` is dropped with a warning.                                                                                      |
| `<CodeGroup>`                                                   | `codeGroup` and `codeTab` | Each fence becomes a code tab titled by the text after its language, such as `npm`.                                                                  |

Attributes can be quoted strings, literal numbers and booleans (`cols={2}`,
`defaultOpen={false}`) or boolean shorthand (`defaultOpen`). The codemod dedents
indented bodies, including those under multi-line opening tags, and keeps LF, CRLF
and CR line endings.

The codemod never guesses. It keeps a file unchanged and reports a warning when
the file contains any of these:

- other components, such as `<Frame>`, `<AccordionGroup>` or `<Icon>`
- dynamic attributes
- MDX imports, exports and expressions
- mismatched closing tags
- components inside tables, headings, lists, blockquotes or paragraph text
- root-absolute image or file paths, such as `/images/a.png`: Topik assets are
  relative to the page, so rewrite them, for example to `../images/a.png`

## Documentation

- [Content format](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT

---
title: Code presentation
description: Label, number, select, fold, wrap and compare fenced code without changing its payload.
---

# Code presentation

Presentation options control how a fenced code block is displayed: labels, line
numbers, highlighted and folded rows, wrapping and diff marks. They never change
the code itself or what readers copy. This page is for authors who write code
examples and for developers who render or store them.

## Add presentation options

Write options after the language on an ordinary fenced code block:

````markdown
```ts filename="client.ts" lines highlight="2" added="3" collapse="3"
const endpoint = "https://example.com";
const retries = 3;
const client = makeClient(endpoint);
```
````

This block displays a filename and line numbers, highlights row 2, marks row 3
as added, and initially folds row 3.

Options work on backtick and tilde fences wherever code blocks are allowed: the
document root, lists, blockquotes, block components and conditional branches.
Each fence has its own options, including each of several fences in a `codeTab`.
A block with an unknown or missing language displays plain code. Mermaid fences
render as diagrams and cannot use presentation options.

## Options

| Option               | Example                                        | Reader behavior                                                            |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `filename`, `title`  | `filename="client.ts" title="Create a client"` | Separate labels; title is primary. Labels grant no file/path authority.    |
| `lines`              | `lines` or `lines=false`                       | Show line numbers; default false. Gutter is excluded from copy.            |
| `startLine`          | `startLine=10`                                 | First displayed number; default 1, maximum 1,000,000,000.                  |
| `highlight`, `focus` | `highlight="1,3-5" focus="3-5"`                | Highlight rows or de-emphasize other rows without hiding them.             |
| `collapse`           | `collapse="3-4,8-9"`                           | Initially fold selected rows; each normalized range expands independently. |
| `wrap`               | `wrap` or `wrap=false`                         | Initial visual wrapping; default false. An accessible toggle changes it.   |
| `added`, `removed`   | `added="3" removed="4"`                        | Disjoint row selections with visible and accessible diff meaning.          |

### Write option values

- Write a true boolean as a bare flag (`lines`) or as `=true`; write `=false` to
  turn it off.
- Quote string values with double or single quotes. A value without spaces can
  be unquoted.
- Recognized options must come first. Topik keeps any remaining metadata after
  them unchanged as an opaque suffix.
- Metadata that begins with an unknown word is ordinary code metadata, not
  presentation options.
- A duplicate option or a malformed value for a recognized option is an error.

Quoted values are read from the raw fence header and then decoded once as
ordinary Markdown text. For example, `title="A &amp; B"` means `A & B`. To show
entity-looking text literally, write `title="A &#38;amp; B"`, which means
`A &amp; B`.

## Select rows

`highlight`, `focus`, `collapse`, `added` and `removed` take a row selection:
positive row numbers or closed ranges, separated by commas, such as `"1,3-5"`.

- Rows are physical code rows counted from **1**. `startLine` changes only the
  displayed numbers, not which rows a selection names.
- Every endpoint must be within the block's physical rows.
- Spaces, zero, descending or open ranges, signs and decimals are invalid.
- Topik sorts the intervals and merges adjacent and overlapping ones.
- `added` and `removed` must not select the same row.

### Fold rows

`collapse` can fold a prefix, a suffix, several middle sections, one row or the
whole block. Each merged interval has its own inline control, and expanding one
interval leaves the others folded.

This example keeps the method signatures and closing braces visible and folds
the two method bodies:

````markdown
```java filename="Client.java" lines collapse="3-4,8-9"
class Client {
  void connect() {
    openSocket();
    authenticate();
  }

  void close() {
    flush();
    disconnect();
  }
}
```
````

## Copying

The copy button always writes **the complete code**. That includes added and
removed rows, `+` and `-` characters written in the source, whitespace and a
final LF. It excludes line numbers and diff markers, and it never reads DOM text
or highlighted HTML. Folding, focus, wrapping and highlighting do not change
what is copied. Empty code copies one LF.

The code value follows Markdown code rules:

- Container indentation is removed, and CR and CRLF line endings become LF.
- Tabs, internal indentation, trailing spaces and blank rows are preserved.
- Physical rows are `value.split("\n")`. An empty value has one row, and a value
  ending in LF has a final empty row.

Code block renderers receive two strings: `payload`, equal to the value, and
`content`, equal to the value plus one LF. `content` is what readers copy; its
extra LF does not create a row.

## Display and accessibility

The plain and rich renderers display the same rows and options.

- Rich rendering passes `payload` to Shiki and checks that the highlighted
  tokens reproduce every row exactly. If highlighting is unavailable, the
  language is unknown, or a check fails, the block shows readable plain code.
- A block with a `title` is a group named by that title, so assistive
  technology announces it.
- The wrap, copy and fold controls are native buttons with keyboard activation,
  accessible wrap and expanded state, and visible focus.
- A fold control stays available while its rows are hidden, and expands or
  collapses only its own interval.
- Diff markers and row meanings do not rely on color alone.
- Server-rendered content, and readers without JavaScript, show every row. The
  controls are disabled until the page hydrates.

## Combine presentation with templates

Presentation options work inside a
[code template](./templates.md#template-a-code-block) scope:

````markdown
{% template code %}

```sh title="Install" lines
npm install {% $package.name %}
```

{% /template code %}
````

The language, options and suffix are literal. Substituted values cannot add
rows, and selections are validated against the resolved code. Topik checks the
options in every conditional branch before it selects one. Presentation options
on their own do not enable templates.

## Storage and formatting

Store unevaluated Markdown as the editable source. Highlighted tokens, line
number gutters and fold or wrap state are never saved. Labels create no Asset
references and add no resource fields or protocols. Editing a fence's metadata
preserves the code payload, the meaning of the suffix, dependencies and the
surrounding source bytes.

Formatting writes recognized options in a fixed order, quotes strings and
ranges, and uses character references where needed to preserve quotes,
ampersands, backslashes and backticks. Topik reparses the output and checks
that its meaning is unchanged, including which options were written explicitly
and every authored branch.

In the authoring tree, a `topikCodePresentation` node holds:

- exactly one `code` or `topikCodeTemplate` child
- `options` with only the explicitly written options, normalized; the authored
  `lines` option is stored as `lineNumbers`
- `opaqueMetaSuffix`, the remaining metadata including its separating spaces or
  tabs

Reader defaults, such as `startLine` 1, are applied at render time and are not
stored.

## Diagnostics

| Problem                                          | Diagnostic id                           |
| ------------------------------------------------ | --------------------------------------- |
| Malformed option syntax or duplicate option      | `topik-code-presentation-metadata`      |
| Invalid label, boolean or `startLine`            | `topik-code-presentation-option`        |
| Malformed row selection                          | `topik-code-presentation-lines`         |
| Selection outside the physical rows              | `topik-code-presentation-line-bounds`   |
| `added` and `removed` select the same row        | `topik-code-presentation-diff-conflict` |
| Options on a `mermaid` fence                     | `topik-code-presentation-language`      |
| Presentation node without exactly one code child | `topik-code-presentation-scope`         |

## Limits

| Item                                           | Limit                                                       |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `filename`, `title`                            | 256 UTF-16 units, nonblank, one line, no control characters |
| Intervals per selection, as written            | 1,024                                                       |
| Option text on one fence                       | 16,384 UTF-16 units                                         |
| Rows in a presented block                      | 20,000                                                      |
| Escaped text and row decorations, per document | 8,000,000 units                                             |

Topik reserves the per-document budget conservatively before it allocates any
output. The ordinary source, tree and data limits also apply.

## Compatibility

Code presentation is part of content schema `0.3.0`; `FORMAT_VERSION` is `2`.
Topik is in development and may make breaking changes. Keep the compiler,
renderer and source-writing packages on matching versions when you adopt syntax
changes.

---
title: Code presentation
description: Label, number, select, fold, wrap and compare fenced code without changing its payload.
---

# Code presentation

Add presentation options after the language on an ordinary fenced code block:

````markdown
```ts filename="client.ts" lines highlight="2" added="3" collapseAfter=2
const endpoint = "https://example.com";
const retries = 3;
const client = makeClient(endpoint);
```
````

This displays a filename and line numbers, highlights row 2, marks row 3 as added,
and initially folds after row 2. Each fence has its own options, including several
fences in a `codeTab`. Options work with backtick or tilde fences wherever code
blocks are allowed: the root, lists, blockquotes, block components and conditional
branches. Unknown or missing text languages display plain code. Mermaid diagrams
cannot use text-code presentation options.

| Option               | Example                                        | Reader behavior                                                          |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `filename`, `title`  | `filename="client.ts" title="Create a client"` | Separate labels; title is primary. Labels grant no file/path authority.  |
| `lines`              | `lines` or `lines=false`                       | Show line numbers; default false. Gutter is excluded from copy.          |
| `startLine`          | `startLine=10`                                 | First displayed number; default 1, maximum 1,000,000,000.                |
| `highlight`, `focus` | `highlight="1,3-5" focus="3-5"`                | Highlight rows or de-emphasize other rows without hiding them.           |
| `collapseAfter`      | `collapseAfter=2`                              | Initially fold after this row; expand retains every row.                 |
| `wrap`               | `wrap` or `wrap=false`                         | Initial visual wrapping; default false. An accessible toggle changes it. |
| `added`, `removed`   | `added="3" removed="4"`                        | Disjoint row selections with visible and accessible diff meaning.        |

Use bare flags for true booleans, or explicit `=true` / `=false`. String values can
be double-quoted, single-quoted or unquoted when they contain no spaces. Recognized
options must come first; any remaining unknown metadata is preserved as an opaque
suffix. Metadata beginning with an unknown word remains ordinary code metadata.
Duplicate options and malformed recognized values are errors.

Selections count physical code rows from **1**, independently of `startLine`.
Use positive rows or closed ranges separated by commas, such as `"1,3-5"`.
Intervals normalize to sorted, merged pairs. Spaces, zero, descending or open
ranges, signs and decimals are invalid. Every endpoint must fit the physical rows,
and `collapseAfter` must leave at least one row available to expand.

Labels are nonblank single-line strings of at most 256 UTF-16 units without
controls. Admission allows at most 1,024 input intervals per selection, 16,384
UTF-16 units of active attributes and 20,000 presented rows. A conservative
document-wide reservation bounds escaped text and row decorations to 8,000,000
units before allocation, alongside existing source, tree and data limits.

## Payload, copying and accessible controls

The authoring `value` uses Markdown code semantics: container indentation is
stripped and CR/CRLF normalize to LF, while tabs, internal indentation, trailing
spaces and authored blank rows are preserved. Physical rows are
`value.split("\n")`; an empty value has one row. A value ending in LF includes its
authored final empty row. The reader keeps separate `payload = value` and
`content = value + "\n"`. This extra separator LF creates no selectable row.

Copy always writes **the complete `content`**, including added and removed rows,
source-authored `+`/`−` characters, whitespace and the terminal LF. It excludes UI
numbers and diff markers and never reads DOM text or highlighted HTML. Folding,
focus, wrapping and highlighting cannot change copied content. Empty code copies
one LF.

Plain and rich renderers share rows/options. Shiki receives payload, with exact
token-row fidelity checks; unavailable/unknown highlighting or errors retain
readable plain code. Native buttons provide keyboard activation, accessible
wrap/expand state and visible focus. Diff markers and row meanings supplement
color. Before hydration every row is displayed and controls are disabled.

## Formatting and source preservation

The parser reads quoted attributes from the raw header before applying ordinary
single-pass Markdown decoding to their values. For example, `title="A &amp; B"`
means `A & B`. Literal entity-looking text can be authored as
`title="A &#38;amp; B"`, which means `A &amp; B`.

Internally, `topikCodePresentation` holds one code or code-template child,
normalized explicit `options`, and an `opaqueMetaSuffix` including its separating
spaces/tabs. Authored `lines` maps to internal `lineNumbers`; reader defaults are
derived rather than saved. Formatting emits readable attributes in a fixed order,
quotes strings and ranges, and uses character references where needed to preserve
quotes, ampersands, backslashes and backticks. Output is reparsed and checked for
semantic equality, including explicit option presence and every authored branch.

Store unevaluated Markdown as the editable source. Highlighted tokens, UI gutters
and fold/wrap state never become saved revisions. Labels create no inferred Asset
references or new resource fields/protocols. Metadata edits preserve the code
payload, suffix meaning, dependencies and complementary source bytes.

## Combining presentation with templates

Presentation attributes work inside an existing code-template scope:

````markdown
{% template code %}

```sh title="Install" lines
npm install {% $package.name %}
```

{% /template code %}
````

Language, options and suffix stay literal. Template substitutions cannot add rows;
resolved bounds are still validated. Every authored branch is admitted before
selecting one branch. Presentation attributes alone enable no interpolation.

The development content grammar is `0.2.2`; `FORMAT_VERSION` remains `1`.
Topik is in development and may make breaking changes. Keep the compiler,
renderer and source-writing packages aligned when adopting syntax changes.

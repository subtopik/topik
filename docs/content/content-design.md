---
title: Content format and normalization
description: Write Topik Markdown and preserve authored content through validation and formatting.
---

# Content format and normalization

Topik Markdown combines Markdown with declarative components, variables, and
conditions. `@topik/content` validates and formats that source, and compiles it
to a reader tree for rendering. The authored document is always the source you
edit and store. This page is for authors who write documents and for developers
who validate, format or store them.

## Write a document

```markdown
# Getting started {% #getting-started %}

Follow the [setup instructions](https://example.com/setup).

{% callout variant="tip" title="Before you begin" %}
Keep a **backup** of your work.
{% /callout %}

Status: {% badge variant="success" %}ready{% /badge %}.
```

A component is written as a tag between `{%` and `%}`:

- Block tags occupy their own lines. Inline tags appear inside prose.
- Properties are literal strings, numbers, or booleans. Selected built-in text
  properties also accept explicit [text templates](./templates.md).
- Topik checks property names, values, and tag placement against the component
  schema.

## Supported Markdown

Topik supports headings, paragraphs, emphasis, strong and strikethrough marks,
inline and fenced code, lists and task lists, blockquotes, hard breaks, links,
images, reference definitions, and tables with alignment. Leading YAML
frontmatter is preserved when formatting and omitted from rendered content.

Raw HTML, footnotes, and executable MDX are unsupported. Topik uses Markdoc-style
tag delimiters but does not implement the full Markdoc language. Topik refuses
unsupported content with a diagnostic; it never flattens it silently.

### Heading anchors

Write `{% #stable-id %}` after a heading to set its anchor. Explicit IDs are
case-sensitive.

Without an explicit ID, Topik generates the anchor from the authored heading
text. A heading whose text yields no anchor characters, such as an empty or
image-only heading, uses `section`. Duplicate anchors receive `-1`, `-2` and so
on, and this applies to `section` too.

Headings in every conditional branch reserve their IDs before evaluation, so
hiding a branch does not rename the anchors in the remaining content.

A generated ID that carries a number depends on position: adding or removing
an earlier heading with the same title moves `details-1` to another heading,
and links to it still resolve, now to the wrong section. The compiler warns
about links to a generated ID whose title other headings share, including the
first one, `details` (`link-fragment-positional`). Titles that differ only in
punctuation can count as shared too: `C++` and `C#` both slug to `c`, so they
get `c` and `c-1`. Give such a heading an explicit ID and link to that instead.

### Links, tables and inline marks

- Bare URLs and email addresses stay text. See [Links](./autolinks.md) for
  explicit link syntax.
- The table header sets the column count. Missing body cells become empty cells;
  extra body cells are refused.
- Emphasis and strong each support at most two nesting levels of their own
  kind. Strikethrough cannot contain strikethrough.

## Built-in components

| Component                                   | Use                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `callout`                                   | A block of prose with an optional `title` and `variant`.                  |
| `accordion`                                 | Collapsible block content with a required `title`.                        |
| `cardGrid`, `card`                          | A grid of cards with titles and optional links and icons.                 |
| `tabs`, `tab`                               | Tab panels; each `tab` needs a `title`.                                   |
| `steps`, `step`                             | An ordered sequence of blocks, with optional step titles.                 |
| `codeGroup`, `codeTab`                      | Labeled code panels containing fenced code.                               |
| `figure`                                    | A self-closing image with `src`, `alt`, and optional caption/dark source. |
| `math`, `mathInline`                        | Self-closing block or inline formulas with a `content` property.          |
| `badge`, `underline` (alias `u`)            | Inline status text or underlined text.                                    |
| `kbd`                                       | An inline key, such as `{% kbd %}Ctrl{% /kbd %}+{% kbd %}C{% /kbd %}`.    |
| `quiz`, `question`, `choice`, `explanation` | Questions, answer choices, and explanations.                              |

Some components accept only specific children. For example, the direct children
of `tabs` are `tab` components, not arbitrary blocks:

```markdown
{% tabs %}
{% tab title="Install" %}
Install the dependencies first.
{% /tab %}
{% tab title="Run" %}
Start your application.
{% /tab %}
{% /tabs %}
```

The exported `components` registry describes each component's complete property
and child rules:

- Unknown components and unknown properties are refused.
- Defaults apply when evaluating or rendering.
- Formatting preserves the distinction between an absent property and an
  explicitly empty value such as `title=""`.

### Custom components

An application adds component schemas through `config.components`. It cannot
replace the built-in schemas. A custom schema is declarative, and its properties
are literal-only. JavaScript callbacks, imports, partials, and arbitrary
expressions inside component properties are unsupported. See the
[package reference](https://github.com/subtopik/topik/blob/main/packages/content/README.md)
for a complete custom-schema example.

## Variables and conditions

The application supplies variable values. The document contains references to
them, in text and in conditions:

```markdown
{% if equals($student.role, "teacher") %}
Teacher notes for {% $student.name %}.
{% else /%}
Hello {% $student.name %}.
{% /if %}
```

Evaluation selects one branch of each condition and inserts each value as
literal text:

- A value such as `**Ada**` is inserted as those characters; it does not become
  Markdown emphasis.
- `null` and the empty string insert no text.
- Prose wrappers left empty are omitted.

[Rendering](./rendering.md#variables) shows how to supply values.

### Condition expressions

Expressions support scalar literals, variable paths, `equals`, `and`, `or`, and
`not`. Only `false` and `null` are false; `0` and an empty string are true.
`and` and `or` short-circuit.

### Evaluation errors

A missing variable is an error only when its reference is evaluated. Compilation
reports these problems:

| ID                       | Problem                               |
| ------------------------ | ------------------------------------- |
| `topik-variable-missing` | A referenced variable is not supplied |
| `topik-variable-type`    | A value has an incompatible type      |
| `topik-variable-control` | A value contains a forbidden control  |
| `topik-expression-type`  | An `equals` operand is not a scalar   |

A `topik-variable-missing` diagnostic carries the reference's line and its
`variable` path. Diagnostics never include supplied values.

### Variables in component properties and code

Use `t"..."` for supported component text attributes and a paired
`{% template code %}` scope for a fenced code example. Ordinary quoted attributes,
inline code, and unwrapped code blocks are literal. See [Text and code
templates](./templates.md) for supported locations, escaping, and value rules.

### Store the authored source

Save the authored source, not evaluated output. Evaluated output has the current
values in place of the variable references and holds only the selected branches.

Conditions control presentation, not access. An application must enforce access
to restricted content before it sends the content to a reader.

`evaluateDocument` returns a separate authoring tree and checks that the tree
can be written faithfully as Markdown. If evaluation leaves a shape that
Markdown cannot represent, such as an empty task item, it throws
`ContentEvaluationError`. Reader-tree compilation does not serialize the result,
so it accepts such shapes.

## Validate and format source

Use the source APIs at import and publishing boundaries. Parsing to an AST
checks structure only; it does not establish that URLs and asset references are
admitted.

| API                    | Result                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `validateTopikContent` | `valid` plus diagnostics in `errors`; no rendering/evaluation.    |
| `formatTopikContent`   | `ok: true` with `formatted`, or `ok: false` with diagnostics.     |
| `compileTopikContent`  | `ok: true` with a reader `tree`, or `ok: false` with diagnostics. |

All three return the exact supplied string in `source`. Validation checks every
authored branch, including branches that evaluation will hide.

```ts
import { formatTopikContent } from "@topik/content";

const source = "# Getting started\n\nKeep a **backup**.\n";
const result = formatTopikContent(source);

if (result.ok) {
  console.log(result.formatted);
} else {
  console.error(result.diagnostics);
  // Retain result.source for correction.
}
```

### Diagnostics

Each diagnostic has a stable `id`, a fixed `message` for that id, a `level`, and
one-based `lines` and `column` when the source location is known. The column is
where the reported node starts on its line. Messages never repeat authored text.
Common source problems include:

| ID                                                | Problem                                                       |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `missing-closing`, `missing-opening`              | A tag has no matching closing tag, or a closing tag no opener |
| `tag-unterminated`, `tag-name-invalid`            | A tag lacks `%}`, or has no valid lowercase name              |
| `attribute-syntax-invalid`, `duplicate-attribute` | Malformed attribute syntax, or an attribute set twice         |
| `tag-closing-invalid`, `tag-placement-invalid`    | Attributes on a closing tag; block or inline tag misplaced    |
| `tag-undefined`                                   | An unknown component                                          |
| `topik-else-placement`, `topik-else-syntax`       | An `else` outside `if`, repeated, or not `{% else /%}`        |
| `topik-expression-invalid`                        | An unsupported condition expression                           |
| `node-undefined`                                  | Unsupported Markdown such as raw HTML, comments, or footnotes |
| `topik-heading-id-placement`                      | A `{% #id %}` that does not end its heading                   |
| `topik-variable-missing`, `topik-variable-type`   | A missing or incompatible variable during compilation         |

`node-undefined` diagnostics set `type` to the Markdown node type, such as
`html` or `footnoteDefinition`. Variable diagnostics set `variable` to the
bounded authored path. Component and attribute diagnostics set `tag` to the
component name and `attribute` to the attribute name; `attribute-undefined`,
`attribute-type-invalid` and `attribute-value-invalid` also set `expected` to
what the component schema accepts, such as the allowed values of `variant`.
Diagnostics never include an authored attribute value.

### What formatting changes

Formatting changes how a document is spelled, never what it means.

It can change wrapping, indentation, list markers,
[inline mark nesting](#inline-mark-nesting), and other equivalent Markdown
spelling. LF, CRLF, and CR inputs are accepted; the output uses LF.

It preserves text, marks, structure, properties, code and formula payloads,
destinations, reference bindings, and every conditional branch.

Topik validates and reparses the output before it returns it. Repeated
formatting is stable for the same format version and configuration.

If the output would change the document's meaning, formatting fails with
`topik-write-failed`, located at the first authored node that would change. The
result has the original source and no partially formatted output.
`writeDocument` throws in the same situation; it never returns lossy Markdown.

### Inline mark nesting

Emphasis, strong, and strikethrough are a set of marks on each piece of inline
content: text, inline code, images, hard breaks, variables, and inline
components. Two documents are the same when every piece carries the same marks:

- Nesting order and repeated marks of one kind carry no meaning. `***a***`,
  `**_a_**`, and `_**a**_` are the same document, as are `*a *b* c*` and
  `*a b c*`.
- A link carries a mark when all of its content does, so `**[a](u)**` and
  `[**a**](u)` are equal too.
- Links keep their identity: one link never becomes two, and adjacent links to
  the same destination stay separate.
- Which characters carry which marks does matter, so `**a** **b**` differs from
  `**a b**`.
- Component children, conditional branches, and block structure are compared
  separately. Marks outside an inline component do not combine with marks
  inside it.

Formatting and `writeDocument` write one canonical nesting for each paragraph,
heading, table cell, and inline component:

1. Adjacent text with the same marks is merged.
2. At each position, the mark whose run of consecutive marked content reaches
   farthest opens first and covers that whole run. Ties prefer emphasis, then
   strong, then strikethrough, so bold italics are written as one `***a***`
   delimiter run.
3. Marks that cover exactly one link are written outside it, as in
   `**[a](u)**`. They move inside, as in `[**a**](u)s`, when a letter or other
   non-punctuation character of unmarked neighboring text would otherwise touch a
   delimiter, unless the link content starts or ends with whitespace or a hard
   break.

Formatting the canonical output again returns it unchanged.

## Work with trees

The AST APIs require independent plain-data nodes. Cycles, shared node objects,
getters, and executable values are refused. An application that manipulates
trees must keep to those constraints as well as the component rules.

## Versions

The current content schema version is `0.2.2` and `FORMAT_VERSION` is `1`. These
versions describe the content contract. They are separate from package versions
and from the `apiVersion` of [resource envelopes](../resources/index.md).

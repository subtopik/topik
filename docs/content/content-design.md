---
title: Content format and normalization
description: Write Topik Markdown and preserve authored content through validation and formatting.
---

# Content format and normalization

Topik combines Markdown with declarative components, variables, and conditions.
`@topik/content` validates and formats that source, or produces a reader tree for
rendering. The authored document remains the source you edit and store.

## Write a document

```markdown
# Getting started {% #getting-started %}

Follow the [setup instructions](https://example.com/setup).

{% callout variant="tip" title="Before you begin" %}
Keep a **backup** of your work.
{% /callout %}

Status: {% badge variant="success" %}ready{% /badge %}.
```

Block tags occupy their own lines. Inline tags appear inside prose. Properties
are literal strings, numbers, or booleans; selected built-in text properties also
accept explicit [text templates](./templates.md). Topik checks their names,
values, and placement against the component schema.

## Supported Markdown

Topik supports headings, paragraphs, emphasis, strong and strikethrough marks,
inline and fenced code, lists and task lists, blockquotes, hard breaks, links,
images, reference definitions, and tables with alignment. Leading YAML
frontmatter is preserved when formatting and omitted from rendered content.

Use `{% #stable-id %}` after a heading to set its anchor explicitly. Without an
explicit ID, Topik generates an anchor from the authored heading text. All
conditional branches reserve heading IDs before evaluation, so hiding a branch
does not rename anchors in the remaining content. Explicit IDs are case-sensitive.

Raw HTML, footnotes, and executable MDX are unsupported. Topik uses Markdoc-style
tag delimiters but does not implement the full Markdoc language. Bare URLs and
email addresses stay text; see [Links](./autolinks.md) for explicit link syntax.

The table header sets its column count. Missing body cells become empty cells;
extra body cells are refused. Emphasis and strong each support at most two
nesting levels of their own kind; strikethrough cannot contain strikethrough.
Unsupported content receives diagnostics instead of being silently flattened.

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
| `quiz`, `question`, `choice`, `explanation` | Questions, answer choices, and explanations.                              |

For example, a tab set contains `tab` components, rather than arbitrary blocks
as its direct children:

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
and child rules. Unknown components or properties are refused. Defaults apply
when evaluating or rendering; formatting preserves the distinction between an
absent property and an explicitly empty value such as `title=""`.

Applications can add schemas through `config.components`, but cannot replace the
built-in schemas. Custom schemas are declarative and their properties remain
literal-only. JavaScript callbacks, imports, partials, and arbitrary expressions
inside component properties are unsupported. See the
[package reference](https://github.com/subtopik/topik/blob/main/packages/content/README.md)
for a complete custom-schema example.

## Variables and conditions

Variable values come from the application. The document contains references:

```markdown
{% if equals($student.role, "teacher") %}
Teacher notes for {% $student.name %}.
{% else /%}
Hello {% $student.name %}.
{% /if %}
```

Expressions support scalar literals, variable paths, `equals`, `and`, `or`, and
`not`. Only `false` and `null` are false; `0` and an empty string are true.
`and` and `or` short-circuit. A missing variable raises an evaluation error when
its reference is evaluated.

Evaluation selects a branch and inserts values as literal text. A value such as
`**Ada**` stays literal text rather than becoming Markdown emphasis. Null and
empty-string values insert no text. Empty prose wrappers are omitted.

Use `t"..."` for supported component text attributes and a paired
`{% template code %}` scope for a fenced code example. Ordinary quoted attributes,
inline code, and unwrapped code blocks remain literal. See [Text and code
templates](./templates.md) for supported locations, escaping, and value rules.

Keep the authored source when saving content. Saving evaluated output would
replace variable references with their current values and discard other branches.
Conditions control presentation; applications must enforce access to restricted
content before sending it to a reader. [Rendering](./rendering.md#variables)
shows how to supply values.

`evaluateDocument` returns a separate authoring tree and checks that it can be
written faithfully as Markdown. If evaluation leaves an unrepresentable shape,
such as an empty task item, it throws `ContentEvaluationError`. Reader-tree
compilation does not need to serialize that result and can retain such shapes.

## Validate and format source

Use source APIs at import and publishing boundaries. Parsing an AST checks
structure but does not establish that its URLs and asset references are admitted.

| API                    | Result                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `validateTopikContent` | `valid` plus diagnostics in `errors`; no rendering/evaluation.    |
| `formatTopikContent`   | `ok: true` with `formatted`, or `ok: false` with diagnostics.     |
| `compileTopikContent`  | `ok: true` with a reader `tree`, or `ok: false` with diagnostics. |

All three retain the exact supplied string in `source`. Validation checks every
authored branch, including branches that will be hidden during evaluation.

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

Formatting can change wrapping, indentation, list markers, and other equivalent
Markdown spelling. It preserves text, marks, structure, properties, code and
formula payloads, destinations, reference bindings, and every conditional branch.
Successful output is validated and reparsed before it is returned. Repeated
formatting is stable for the same format version and configuration.

If serialization would change the document's meaning, formatting fails with the
original source. `writeDocument` likewise throws rather than returning lossy
Markdown. Failed operations never provide partially formatted output. LF, CRLF,
and CR inputs are accepted; canonical output uses LF.

AST APIs require independent plain-data nodes: cycles, shared node objects,
getters, and executable values are refused. Applications manipulating trees must
preserve those constraints as well as the component rules.

The current content schema version is `0.2.2` and `FORMAT_VERSION` is `1`. These
versions describe the content contract, separately from package versions and the
`apiVersion` of [resource envelopes](../resources/index.md).

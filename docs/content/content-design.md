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
its reference is evaluated. Compilation reports it as `topik-variable-missing`
with the reference's line and its `variable` path; incompatible values report
`topik-variable-type`, forbidden controls `topik-variable-control`, and
non-scalar `equals` operands `topik-expression-type`. Supplied values are never
included.

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

Each diagnostic has a stable `id`, a fixed `message` for that id, a `level`, and
one-based `lines` when the source location is known. Messages never repeat
authored text. Common source problems include:

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
bounded authored path.

Formatting can change wrapping, indentation, list markers, inline mark nesting,
and other equivalent Markdown spelling. It preserves text, marks, structure,
properties, code and formula payloads, destinations, reference bindings, and
every conditional branch.
Successful output is validated and reparsed before it is returned. Repeated
formatting is stable for the same format version and configuration.

### Inline mark nesting

Emphasis, strong, and strikethrough are a set of marks on each piece of inline
content: text, inline code, images, hard breaks, variables, and inline
components. Their nesting order and repeated marks of one kind carry no meaning,
so `***a***`, `**_a_**`, and `_**a**_` are the same document, as are `*a *b* c*`
and `*a b c*`. A link carries a mark when all of its content does, so
`**[a](u)**` and `[**a**](u)` are equal too. Links keep their identity: one link
never becomes two, and adjacent links to the same destination stay separate.
Which characters carry which marks still matters, so `**a** **b**` differs from
`**a b**`. Component children, conditional branches, and block structure are
compared separately; marks outside an inline component do not combine with
marks inside it.

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

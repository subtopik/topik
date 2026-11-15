# @topik/remark-tags

Declare inline and block tags in Markdown using `{% name %}` syntax. This package
provides a remark plugin and the underlying micromark and mdast extensions. Use it
when you need to parse and write tag syntax in a unified or mdast pipeline. It
handles syntax only: component schemas, expression evaluation, and rendering
belong to your application. For a complete content model with validation and
rendering, use `@topik/content`, which is built on this package.

This is an ESM package and requires Node.js 22.22 or later.

## Install and use

```sh
npm install @topik/remark-tags unified remark-parse remark-stringify
```

Declare each tag name with its placement, then add the plugin to a processor:

```js
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkTags from "@topik/remark-tags";

const tags = {
  badge: { kind: "inline" },
  panel: { kind: "block" },
};

const processor = unified().use(remarkParse).use(remarkTags, tags).use(remarkStringify);

const file = processor.processSync(`{% panel title="Release" %}
Available {% badge %}**today**{% /badge %}.
{% /panel %}`);

console.log(String(file));
```

The default export and the named `remarkTags` export are the same plugin.

## Options

Pass options as the plugin's third `.use()` argument, or as the second argument
to each extension.

| Option              | Type                       | Effect                                                                                                                           |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `expressions`       | `boolean`                  | Enables variables, conditions, text templates, and code templates; see [Optional expression syntax](#optional-expression-syntax) |
| `escapedWhitespace` | `Record<string, string[]>` | Names, per tag, the ordinary string attributes that accept `\n`, `\r` and `\t` escapes, for example `{ math: ["text"] }`         |
| `fencedCodeHeaders` | `WeakMap<Node, string>`    | Receives the raw opening-fence header of each fenced code block, including code templates, keyed by its node                     |

## Work with mdast directly

When you use the extensions without unified, pass the same declarations and
options to all three:

```js
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { tagSyntax, tagFromMarkdown, tagToMarkdown } from "@topik/remark-tags";

const tags = { badge: { kind: "inline" } };
const tree = fromMarkdown('{% badge label="Preview" /%}', {
  extensions: [tagSyntax(tags)],
  mdastExtensions: [tagFromMarkdown(tags)],
});
const source = toMarkdown(tree, { extensions: [tagToMarkdown(tags)] });
```

## Syntax

This is Markdoc-style syntax, not a complete Markdoc implementation.

- Declare each tag's placement as `inline` or `block`. Undeclared names are
  errors.
- Write `{% badge /%}` for a self-closing tag or
  `{% badge %}Markdown children{% /badge %}` for a paired tag.
- Block opening and closing tags occupy their own lines, including inside lists
  and blockquotes. An inline tag on its own line is part of the surrounding
  paragraph.
- Names start with a lowercase ASCII letter, followed by letters, digits, or
  hyphens. Names are case-sensitive; camelCase is supported.
- Tags nest within Markdown boundaries. Opening a tag inside emphasis and
  closing it outside, or opening an inline tag in one paragraph and closing it
  in another, is an error.
- Tag-looking text in code, escaped openers, and raw HTML blocks is literal
  text.

### Attributes

Attributes use `key=value` with double-quoted strings, finite numbers, or
booleans: `title="Preview" columns=2 open=true`.

- Strings support the `\\`, `\"`, `\|`, `\[`, and `\]` escapes.
- Empty strings are kept as empty strings.
- Control characters are refused. The `escapedWhitespace` option admits the
  `\n`, `\r` and `\t` escapes for the attributes it names; raw control
  characters and all other control escapes are refused everywhere.

### Other Markdown syntax

Standard remark directives (`:name`, `::name`, `:::name`) are a separate syntax
and work alongside tags. GFM and other Markdown features come from their own
plugins.

## Optional expression syntax

Set `{ expressions: true }` to enable variables and conditions:

```md
Hello {% $student.name %}.

{% if equals($student.role, "mentor") %}
Mentor instructions.
{% else /%}
Student instructions.
{% /if %}
```

- Variable paths are dot-separated identifiers.
- Conditions are block-only, with at most one else branch.
- `if` and `else` are reserved: declaring a tag with either name throws.
- Conditions are kept as opaque source strings with balanced quotes and safe
  delimiters. This package does not evaluate them or validate an expression
  language; your application supplies that behaviour.

### Explicit text templates

The same option enables `t"..."` attribute values and paired code-template
scopes:

````md
{% panel title=t"Install {% $package.name %}" %}
{% template code %}

```sh
npm install {% $package.name %}
echo '{%% $literal.example %}'
```

{% /template code %}
{% /panel %}
````

Only explicit templates are interpolated: ordinary quoted attributes and
ordinary code blocks are literal.

Template rules:

- Inside a template, `{% $path %}` is a variable reference and `{%%` produces
  the literal opener `{%`.
- Escapes are processed once: `{%%%` produces `{%%`.
- Backslashes in code are literal. Attribute templates apply the usual
  quoted-string escapes before references are scanned.
- Attribute template literals cannot contain control characters or line breaks.
- Code literals cannot contain NUL or carriage returns; source line endings are
  normalized to LF.
- Template paths use dot-separated ASCII identifiers and refuse `__proto__`,
  `prototype`, and `constructor` segments.

Code scope rules:

- The `{% template code %}` and `{% /template code %}` markers occupy their own
  block lines and contain exactly one closed fenced block in the same Markdown
  parent.
- Scopes can appear inside lists, blockquotes, declared block tags, and
  conditional branches.
- Extra content, nested scopes, indented code, missing closers, and interpreted
  `mermaid` code are refused.
- The fence language and metadata are literal.
- The markers are two-word forms, so they do not conflict with custom tags
  named `template` or `codeTemplate`.

A template attribute's value is an exported `TagTextTemplate`:

```ts
{
  type: "topikTextTemplate",
  segments: [
    { type: "literal", value: "Install " },
    { type: "variable", path: ["package", "name"] },
  ],
}
```

A code template parses to a `tagCodeTemplate` leaf with `lang`, `meta`, and
`template`; it has no ordinary `value` or children. An empty or literal-only
template is still a template, not an ordinary string or code block.

`writeTextTemplate(template)` returns a template's source text, with variable
references and escaped openers; pass `true` as the second argument for a code
payload.

Your application chooses which attribute slots accept templates, resolves the
references, and renders the resulting text. This package preserves the authored
structure without evaluating it.

## AST

| Node              | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `tagText`         | Inline tag with phrasing children; self-closing tags have no children |
| `tagLeaf`         | Self-closing block tag with no children                               |
| `tagContainer`    | Paired block tag with block/definition children                       |
| `tagVariable`     | Opt-in variable reference with a string `path`                        |
| `tagConditional`  | Opt-in conditional containing one or two `tagBranch` nodes            |
| `tagBranch`       | Flow children with a condition string, or `null` for the else branch  |
| `tagCodeTemplate` | Opt-in fenced code with literal language/metadata and a text template |

- Component nodes contain `name` and `attributes`.
- Parsed nodes carry source positions.
- The exported node interfaces augment mdast's node maps for TypeScript users.
- A branch's position spans from its `if` or `else` marker through its last
  child, excluding the following marker and trailing blank lines. An empty
  branch covers only its opening marker.

## Writing Markdown

The writer produces canonical output: formatting preserves the meaning of a
supported tree, not its source bytes.

- Attribute names are sorted by code unit, values are escaped, and spacing is
  normalized.
- An empty block container is written as a container; an empty inline tag is
  written as a self-closing tag.
- `null` and `undefined` attribute values in constructed trees are omitted.
- Attribute maps you build must be plain objects (null-prototype objects are
  allowed) with enumerable own data properties. Accessors and custom prototypes
  are refused without invoking their getters.

For template output, the writer merges adjacent literal segments, escapes
literal openers, and chooses a fence that preserves the payload. Decoded fence
metadata, including tabs and leading spaces, is written with character
references when needed so that it parses back unchanged.

## Diagnostics and limits

Malformed source throws `TagSyntaxError`. Its `diagnostics` array contains
entries with a `message`, a stable `id`, and, when available, a one-based `line`
and `column`. Invalid declarations and unsupported writer inputs throw ordinary
errors.

| ID                                                        | Problem                                                 |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `missing-closing`                                         | An opened tag is never closed                           |
| `missing-opening`                                         | A closing tag does not match the innermost open tag     |
| `tag-unterminated`                                        | A tag marker lacks its closing `%}`                     |
| `tag-name-invalid`                                        | A tag has no valid lowercase name                       |
| `attribute-syntax-invalid`                                | Malformed attribute syntax, escape, or unquoted value   |
| `attribute-value-invalid`                                 | A literal attribute contains a control character        |
| `duplicate-attribute`                                     | An attribute appears more than once                     |
| `tag-closing-invalid`                                     | A closing tag has attributes or a self-closing slash    |
| `tag-undefined`                                           | A tag name is not declared                              |
| `tag-placement-invalid`                                   | A block tag appears inline, or an inline tag as a block |
| `tag-content-limit`                                       | A structural limit is exceeded                          |
| `topik-else-placement`, `topik-else-syntax`               | A misplaced or repeated `else`, or not `{% else /%}`    |
| `topik-expression-invalid`, `topik-conditional-placement` | Invalid `if` source, or a block `if` inside text        |
| `topik-variable-path`, `topik-variable-placement`         | An invalid variable path, or a variable outside text    |

Template syntax reports the `topik-template-syntax`, `topik-variable-path`,
`topik-template-control`, `topik-code-template-structure`, and
`topik-code-template-language` diagnostic IDs.

`TAG_LIMITS` sets these bounds:

- `treeDepth` 128 and `treeNodes` 50,000, for both the incoming Markdown tree
  and the converted tag tree. The converted tree's count includes template
  objects and segments.
- `templateLength` 1,000,000 UTF-16 units, for each template's decoded input
  payload and for its generated source. Generated source for a quoted template
  counts the `t` prefix, the quotes, and the surrounding Markdown escapes; for
  a code template it counts the generated fences and scope markers.

These limits do not bound a whole source document. Your application sets its own
input limits and rendering policy.

## Edge cases

- A blank line separates an HTML block from a following tag marker in written
  output.
- Blank lines inside a block tag do not make the enclosing list item loose;
  blank lines between the item's direct block children do.
- Literal tag openers are escaped without changing URL or email autolinks.
- When emphasis or strong marks nest across inline tags, the writer alternates
  their delimiters to keep the tag boundaries intact, then restores the
  surrounding writer's preferences after each tag.
- Brackets in attributes inside Markdown labels, including native directive
  labels, are escaped so that the label structure survives.

## Contributing

Contributor tooling uses the workspace's `.node-version` and requires Node.js
`^22.23.4 || ^24.11.0 || >=26.0.0` for Vite+, Vitest, and Astro integration
tests. CI verifies the built library on Node.js 22.22 separately from the test
runner.

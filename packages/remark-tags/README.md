# @topik/remark-tags

Declare inline and block tags in Markdown using `{% name %}` syntax. This package
provides a remark plugin and the underlying micromark/mdast extensions. It parses
and writes syntax; component schemas, expression evaluation, and rendering belong
to the application.

## Install and use

```sh
npm install @topik/remark-tags unified remark-parse remark-stringify
```

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

The default export and named `remarkTags` export refer to the same plugin. This is
an ESM package requiring Node.js 22.12 or later.

Contributor tooling uses the workspace's `.node-version` and requires
`^22.18.0 || ^24.11.0 || >=26.0.0` for Vite+ 1.0 and Vitest 5. CI verifies the
built library on Node.js 22.12 separately from the test runner.

## Syntax

- Declare each tag's placement as `inline` or `block`. Unknown names are errors.
- Block opening and closing tags occupy their own lines, including inside lists
  and blockquotes. An inline tag on its own line stays in the surrounding paragraph.
- Use `{% badge /%}` for a self-closing tag or
  `{% badge %}Markdown children{% /badge %}` for a paired tag.
- Names start with a lowercase ASCII letter, followed by letters, digits, or
  hyphens. Names are case-sensitive; camelCase is supported.
- Attributes use `key=value` with double-quoted strings, finite numbers, or
  booleans: `title="Preview" columns=2 open=true`. Strings support `\\`, `\"`,
  `\|`, `\[`, and `\]` escapes. Empty strings are preserved; control characters
  are refused. Applications can explicitly admit `\n`, `\r` and `\t`
  for named ordinary string attributes with
  `escapedWhitespace: { component: ["attribute"] }`;
  raw control characters and all other control escapes remain refused.
  The writer escapes brackets in attributes inside Markdown labels,
  including native directive labels, to preserve their surrounding structure.
- Tag-looking text in code, escaped openers, and raw HTML blocks remains literal.
- Tags nest within Markdown boundaries. Opening inside emphasis and closing
  outside it, or opening an inline tag in one paragraph and closing it in another,
  is an error.

This is Markdoc-style syntax, not a complete Markdoc implementation. Standard
remark directives (`:name`, `::name`, `:::name`) remain independent. GFM and other
Markdown features are enabled through their own plugins.

The writer sorts attribute names by code unit, escapes values, and normalizes
spacing. It preserves an empty block container as a container; empty inline tags
normalize to self-closing tags. Null and undefined attribute values in constructed
trees are omitted. Caller-built attribute maps must be plain objects (including
null-prototype objects) with enumerable own data properties; accessors and custom
prototypes are refused without invoking their getters. Formatting preserves
supported tree meaning, not source bytes.
HTML blocks remain separated from following tag markers by a blank line. Blank
lines inside a block tag do not make its enclosing list item loose; blank lines
between the item's direct block children still do.
Literal tag openers are escaped without changing URL or email autolinks. When
emphasis or strong marks nest across inline tags, their delimiters alternate to
keep the tag boundaries intact; the surrounding writer's preferences are restored
after each tag.

## AST and extensions

| Node              | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `tagText`         | Inline tag with phrasing children; self-closing tags have no children |
| `tagLeaf`         | Self-closing block tag with no children                               |
| `tagContainer`    | Paired block tag with block/definition children                       |
| `tagVariable`     | Opt-in variable reference with a string `path`                        |
| `tagConditional`  | Opt-in conditional containing one or two `tagBranch` nodes            |
| `tagBranch`       | Flow children with a condition string, or `null` for the else branch  |
| `tagCodeTemplate` | Opt-in fenced code with literal language/metadata and a text template |

Component nodes contain `name` and `attributes`. Parsed nodes retain source
positions. Exported node interfaces augment mdast's node maps for TypeScript users.
Branch positions span from the `if` or `else` marker through the last child,
excluding the following marker and trailing blank lines. Empty branches cover
only their opening marker.

Use the same declarations and options with all three extensions when working
directly with mdast:

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

## Optional expression syntax

Pass `{ expressions: true }` as the plugin's third `.use()` argument, or as the
second argument to each extension, to enable:

```md
Hello {% $student.name %}.

{% if equals($student.role, "mentor") %}
Mentor instructions.
{% else /%}
Student instructions.
{% /if %}
```

Variable paths are dot-separated identifiers. Conditions are preserved as opaque
source strings with balanced quotes and safe delimiters; this package neither
evaluates them nor validates an expression language. Applications must supply that
behavior. `if` and `else` are reserved declaration names when expressions are
enabled. Conditions are block-only, with at most one else branch.

### Explicit text templates

The same option enables `t"..."` attribute values and paired code-template scopes:

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

Ordinary quoted attributes and ordinary code blocks retain their literal meaning.
Inside an explicit template, `{% $path %}` is a reference and `{%%` produces the
literal opener `{%`. Escape processing runs once: `{%%%` produces `{%%`. Code
backslashes stay literal; attribute templates use the usual quoted-string escapes
before scanning their references. Attribute template literals cannot contain
controls or line breaks. Code literals cannot contain NUL or carriage returns;
source line endings normalize to LF. Template paths use dot-separated ASCII
identifiers and refuse `__proto__`, `prototype`, and `constructor` segments.

Code scope markers occupy their own block lines and contain exactly one closed
fenced block in the same Markdown parent. They can appear inside lists,
blockquotes, declared block tags, and conditional branches. Extra content,
nested scopes, indented code, missing closers, and interpreted `mermaid` code are
refused. Language and metadata stay literal. The special two-word markers leave
custom tags named `template` and `codeTemplate` available.

Template attributes contain an exported `TagTextTemplate` value:

```ts
{
  type: "topikTextTemplate",
  segments: [
    { type: "literal", value: "Install " },
    { type: "variable", path: ["package", "name"] },
  ],
}
```

`tagCodeTemplate` is a leaf with `lang`, `meta`, and `template`; it has no ordinary
`value` or children. Empty and literal-only templates keep their template identity.
The writer merges adjacent literal segments, escapes literal openers, and chooses
a fence that preserves the payload. It preserves decoded fence metadata through
character references when needed, including tabs and leading spaces. Applications
choose eligible attribute slots, resolve references, and render the resulting text;
this package preserves the authored structure without evaluating it.

## Diagnostics and limits

Malformed source throws `TagSyntaxError`. Its `diagnostics` array contains a
`message` and, when available, one-based `line` and `column`. Structural limit
errors also have `id: "tag-content-limit"`. Invalid declarations and unsupported
writer inputs throw ordinary errors.

Template syntax uses stable `topik-template-syntax`, `topik-variable-path`,
`topik-template-control`, `topik-code-template-structure`, and
`topik-code-template-language` diagnostic IDs.

`TAG_LIMITS` bounds both the incoming Markdown tree and the converted tag tree to
depth 128 and 50,000 nodes, counting template objects and segments in the converted
tree. It also bounds each template's decoded input payload and generated source
value to 1,000,000 UTF-16 units. Quoted template output counts the `t` prefix,
quotes, and surrounding Markdown escape rules; code output counts generated
fences and scope markers.
These limits do not bound an entire source document. Host applications remain
responsible for their own input limits and rendering policy.

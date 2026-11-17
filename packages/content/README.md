# @topik/content

Portable Markdown with declarative components, variables, and conditions. Use
this package to validate, format, evaluate, and compile Topik content in any
JavaScript runtime: it provides an mdast authoring tree, validation, lossless
source operations, and a framework-independent render tree. For React rendering,
use `@topik/content-react`. Editing, storage, and synchronization belong to your
application.

The package is ESM and requires Node.js 22.22 or later. Install it with your
package manager:

```sh
npm install @topik/content
```

## Validate, format, and render

Format the authored source, then compile it into a render tree. Store the
authored source and pass the derived tree to your renderer.

```ts
import { formatTopikContent, compileTopikContent } from "@topik/content";

const source = '# Welcome\n\n{% callout variant="tip" %}\nKeep a **backup**.\n{% /callout %}';
const formatted = formatTopikContent(source);
if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));

const compiled = compileTopikContent(formatted.formatted);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
const tree = compiled.tree;
// Store authored source; pass the derived tree to your renderer.
if (tree === null) throw new Error("Expected rendered content");
```

- `compileTopikContent` validates source and produces the render tree in one
  pipeline. It accepts authored content and the canonical asset references that
  the compiler generates.
- `formatTopikContent` validates both its input and its output, and checks that
  serialization preserves the authored content. Every result carries the exact
  input as `source`, so a failure never alters what the author wrote.

## Choose an API

| Task                                        | API                                                              |
| ------------------------------------------- | ---------------------------------------------------------------- |
| Admit untrusted source                      | `validateTopikContent` or `compileTopikContent`                  |
| Format source canonically                   | `formatTopikContent`                                             |
| Compile source into a render tree           | `compileTopikContent`                                            |
| Render an already-parsed tree               | `transformTopikContent`                                          |
| Parse, check, and write the authoring tree  | `parseDocument`, `validateDocument`, `writeDocument`             |
| Select branches and insert variable values  | `evaluateDocument`                                               |
| Compare two admitted documents              | `sameDocumentMeaning`                                            |
| Find and replace asset references           | `extractTopikAssetOccurrences`, `rewriteTopikAssetOccurrences`   |
| Read and write `ref://` resource identities | `parseTopikResourceReference`, `serializeTopikResourceReference` |
| Check a custom component configuration      | `mergeTopikContentConfig`                                        |

`parseDocument` and `validateDocument` check tree structure and component rules.
They do not apply URL, navigation, or asset admission policies, so admit
untrusted source with `validateTopikContent` or `compileTopikContent`.

`writeDocument` serializes a supported authoring tree. Trees passed to the
document APIs must be plain data with independent node objects: cycles, shared
nodes, accessors, and executable values are refused.

## Markdown and components

Supported Markdown:

- headings, emphasis, strong and strikethrough marks, and code
- lists and task lists, blockquotes, and hard breaks
- links, images, and reference definitions
- tables
- leading YAML frontmatter, which is kept in the source but not rendered

Raw HTML and footnotes are refused. Bare URLs and email addresses are text; to
make a link, write an explicit Markdown link or an angle-bracket autolink.

### Links between resources

A portable document destination is a resource identity:
`ref://wiki-page/<name>`, `ref://guide/<name>`, or `ref://course-page/<name>`,
where `<name>` is the target resource's name. `parseTopikResourceReference` and
`serializeTopikResourceReference` keep the query and fragment separate from any
publishing route. Your renderer resolves these identities to browser URLs; see
the
[resource-link reference](https://github.com/subtopik/topik/blob/main/docs/resources/navigation.md#links-between-pages).

### Components

Components are written as tags. Block tags occupy their own lines; inline tags
appear inside prose. Properties are literal strings, numbers, and booleans;
selected built-in text properties also accept explicit templates (see
[Text and code templates](#text-and-code-templates)). Unsupported syntax is
reported as a diagnostic, never silently discarded.

| Component                                   | Content and principal properties                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `callout`                                   | Block content; optional `variant` and `title`                                                       |
| `accordion`                                 | Block content; required `title`, optional `open`                                                    |
| `cardGrid`, `card`                          | Cards; grid `columns` from 1 to 4; card requires `title` and accepts `href`, `icon`                 |
| `tabs`, `tab`                               | One or more tabs, each with a required `title`                                                      |
| `steps`, `step`                             | One or more steps; optional step `title`                                                            |
| `codeGroup`, `codeTab`                      | One or more code tabs; each requires `title` and fenced code                                        |
| `figure`                                    | Self-closing; required `src` and `alt`, optional `darkSrc` and `caption`                            |
| `math`, `mathInline`                        | Self-closing block/inline formula with required `content`                                           |
| `badge`                                     | Inline content; optional `variant`                                                                  |
| `underline` (alias `u`)                     | Inline content                                                                                      |
| `quiz`, `question`, `choice`, `explanation` | Questions with at least two choices; `type` selects single/multiple choice, `correct` marks answers |

The exported `components` registry contains the complete property, placement,
and child constraints. Defaults apply when content is read or rendered; writing
a document does not add properties the author left out.

Math `content` can encode line breaks and tabs with the `\n`, `\r`, and `\t`
escapes. These escapes are literal formula data: they do not create Markdown
blocks or inline nodes. All other attributes refuse control characters.

### Code blocks

Fenced code accepts presentation attributes such as `filename="Client.java"`,
`lines`, `highlight="2"` and `collapse="3-4,8-9"`:

- Line selections are closed ranges of physical rows. They are normalized to
  sorted, merged intervals.
- Each collapsed interval has its own inline control.
- Copy always copies the full, exact code.
- Every row is visible before hydration and without JavaScript.

See the
[code presentation reference](https://github.com/subtopik/topik/blob/main/docs/content/code-presentation.md)
for options, limits and source-preservation rules.

## Variables and conditions

`evaluateDocument` selects condition branches and inserts variable values as
literal text. It never executes JavaScript or interprets an inserted value as
Markdown. The evaluated document is a derived result: save the authored document
to keep its variables and every branch.

```ts
import { evaluateDocument, parseDocument, writeDocument } from "@topik/content";

const source = [
  '{% if equals($student.role, "teacher") %}',
  "Hello {% $student.name %}.",
  "{% else /%}",
  "Student instructions.",
  "{% /if %}",
].join("\n");
const parsed = parseDocument(source);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));

const evaluated = evaluateDocument(parsed.document, {
  student: { role: "teacher", name: "Ada" },
});
if (writeDocument(evaluated) !== "Hello Ada.\n") throw new Error("Unexpected evaluation");
```

Conditions control presentation only; they do not enforce authorization.

Expression rules:

- Expressions contain scalar literals, variable paths, `equals`, `and`, `or`,
  and `not`.
- Only `false` and `null` are false. `and` and `or` short-circuit.
- Null and empty strings insert no text.

Errors:

- `evaluateDocument` throws `ContentEvaluationError` when an evaluated path names
  a missing variable.
- `compileTopikContent` reports variable failures in the body and in conditions
  as `topik-variable-missing`, `topik-variable-type`, or
  `topik-variable-control`, and non-scalar `equals` operands as
  `topik-expression-type`. Each diagnostic carries the source line and the
  bounded `variable` path, never the supplied value.

For how evaluation treats empty output and variable headings, see
[Evaluation output](#evaluation-output) and [Heading IDs](#heading-ids).

## Text and code templates

Templates insert variable values into property text and code blocks. Ordinary
quoted properties and code blocks are always literal; only explicit templates
are interpolated.

- **Text templates.** Write `t"..."` for `title` on `callout`, `accordion`,
  `card`, `tab`, `step`, and `codeTab`, or for `alt` and `caption` on `figure`.
- **Code templates.** Wrap exactly one fenced code block between
  `{% template code %}` and `{% /template code %}`, each on its own block line.

```ts
import { compileTopikContent, formatTopikContent } from "@topik/content";

const source = [
  '{% callout title=t"Install {% $package.name %}" %}',
  "{% template code %}",
  "~~~sh",
  "npm install {% $package.name %}@{% $package.version %}",
  "~~~",
  "{% /template code %}",
  "{% /callout %}",
].join("\n");
const formatted = formatTopikContent(source);
if (!formatted.ok) throw new Error(JSON.stringify(formatted.diagnostics));
const compiled = compileTopikContent(source, {
  config: { variables: { package: { name: "example-kit", version: "1.2.3" } } },
});
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
// Store source or formatted.formatted; compiled.tree contains reader values.
if (compiled.source !== source) throw new Error("Authoring source changed");
```

Formatting preserves unevaluated templates and every branch; evaluation produces
a separate derived result.

Template syntax:

- `{% $path %}` inserts a scalar value, and `{%%` writes a literal `{%`.
- Scanning is single-pass: inserted values and escaped literals are never read
  as new tokens.
- Backslashes in code are unchanged. Attribute templates use the ordinary
  quoted-string escapes.
- Paths are dotted identifier segments. Expressions, functions, defaults, and
  bracket paths are not supported.

Inserted values:

- Strings, finite numbers, and booleans are inserted as raw text; null and empty
  strings insert nothing.
- Each substitution must be a single line. Missing or incompatible values, and
  values containing C0 or DEL control characters (including newlines and tabs),
  fail with a diagnostic.
- Values never create Markdown or HTML structure and receive normal renderer
  escaping. Authors supply any shell, JSON, or language quoting themselves.
- Inactive branches are validated as source without resolving their variables.

Code template rules:

- The markers and the fence must share one logical parent, which can be a
  `codeTab` body.
- An empty payload is valid. Nested, missing, crossing, multi-fence, and
  indented-code scopes are refused.
- The fence language and metadata are literal.
- Templated `mermaid` fences are refused before diagram handling; unknown
  languages are ordinary code.
- Inline code and code blocks outside a template scope are literal.

URLs, image sources, icons, math, enum properties, and custom component
properties accept literal values only. See the
[template reference](https://github.com/subtopik/topik/blob/main/docs/content/templates.md)
for the complete scope, escape, diagnostic, and source-storage rules.

## Custom components

Add declarative component schemas through `config.components`, and supply the
matching render component in your application.

```ts
import {
  parseTopikContent,
  transformTopikContent,
  validateTopikContent,
  type TopikContentConfig,
} from "@topik/content";

const config: TopikContentConfig = {
  components: {
    notice: {
      kind: "block",
      render: "Notice",
      attributes: { title: { type: "string", required: true } },
      children: "blocks",
    },
  },
};
const source = '{% notice title="Remember" %}\nKeep a backup.\n{% /notice %}';
if (!validateTopikContent(source, { config }).valid) throw new Error("Invalid notice");
transformTopikContent(parseTopikContent(source, { config }), config);
```

Rules:

- Built-in schemas cannot be overridden.
- `if` and `else` are reserved for conditions and cannot be component names.
- Names in `allowedParents` and `children.components` must be registered
  components.
- Custom runtime functions, partials, and executable property values are not
  supported.
- A `string` attribute with `escapedWhitespace: true` accepts the `\n`, `\r`,
  and `\t` escapes, as math `content` does.

Use `ComponentSchema` to type a reusable custom schema. `ComponentDefinition`
also describes the built-in validators used by the runtime registry.

Configuration errors:

- `mergeTopikContentConfig` throws an error whose message names the invalid
  component, attribute, or field, for example
  `Content configuration is invalid: component "notice" attribute "title" required must be a boolean`.
- Source APIs report every configuration failure as the fixed
  `topik-config-invalid` diagnostic.

## Compare documents

`sameDocumentMeaning(left, right)` reports whether two already-admitted
authoring trees mean the same thing.

- It ignores source positions, cosmetic spelling, and derived metadata.
- It compares explicit heading IDs, reference bindings, content order, and every
  conditional branch.
- It does not validate arbitrary trees, and it does not treat an application
  editor's defaults as authored values.

Inline marks compare as a set on each piece of content, the way rich-text
editors store them: `**[a](u)**` equals `[**a**](u)`, `***a***` equals
`**_a_**`, and `**a****b**` equals `**ab**`. Text, link identity, and which
spaces are marked all count, so `**a** **b**` differs from `**a b**`, and one
link differs from two adjacent links.

`writeDocument` and formatting emit one canonical nesting for each set of marks;
see
[inline mark nesting](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md#inline-mark-nesting).
Parsing, asset rewrites, and navigation rewrites keep the authored nesting, so
the tree positions of unchanged content are stable.

## Asset rewriting

`extractTopikAssetOccurrences` lists the asset references in a document, and
`rewriteTopikAssetOccurrences` replaces them through a callback that returns the
new reference, or `undefined` to leave one unchanged.

```ts
import { extractTopikAssetOccurrences, rewriteTopikAssetOccurrences } from "@topik/content";

const result = rewriteTopikAssetOccurrences("![Diagram](old.png)", (occurrence) =>
  occurrence.reference === "old.png" ? "new.png" : undefined,
);
if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
if (extractTopikAssetOccurrences(result.content)[0]?.reference !== "new.png") {
  throw new Error("Asset replacement was not preserved");
}
```

Rewriting rules:

- Rewriting checks every authored branch. On failure it returns diagnostics and
  the original, unchanged `source`.
- Callbacks run after the input is admitted, and exceptions they throw
  propagate.
- Keep callbacks free of side effects: a later replacement can invalidate the
  whole operation.

Accepted references:

- Images and figure sources accept canonical relative paths or credential-free
  HTTPS URLs.
- Compiler-generated `asset:` references are accepted in rewritten output.
  Source admission accepts them only with `allowCompiledAssetReferences: true`.
- Generic links count as download assets only when their decoded file path is
  listed in `provenDownloadPaths`, or when `includeGenericLinkCandidates` asks
  for every candidate.
- Custom component attributes declared as assets are validated with the same
  policy, but they are not part of the compiler's closed set of asset
  occurrences, so extraction and rewriting do not report them.

## Rules and limits

### URL safety

Source admission (`validateTopikContent` and `compileTopikContent`) applies the
URL, navigation, and asset policies. Parsing alone applies none of them.

As defence in depth for trees that never passed admission,
`transformTopikContent` omits link, image, card, and asset attribute URLs that
fail the `validateTopikHref` scheme and shape policy, for example `javascript:`
or `data:` URLs. It also omits a card `href` that is an `asset:` reference. It
does not apply the stricter asset admission rules.

### Diagnostics

Source diagnostics have stable IDs with fixed messages.

| Problem                          | IDs                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tag syntax                       | `missing-closing`, `missing-opening`, `tag-unterminated`, `tag-name-invalid`, `attribute-syntax-invalid`, `duplicate-attribute`, `tag-closing-invalid`, `tag-placement-invalid`, `tag-undefined` |
| `else` placement and syntax      | `topik-else-placement`, `topik-else-syntax`                                                                                                                                                      |
| Unsupported condition expression | `topik-expression-invalid` (reported once)                                                                                                                                                       |
| Unsupported Markdown             | `node-undefined`, at the node's line, with its Markdown node `type`; covers raw HTML, comments, and footnotes                                                                                    |
| Misplaced heading ID             | `topik-heading-id-placement`, for a heading ID that does not end its heading                                                                                                                     |
| Custom schema rules              | `topik-<name>-children`, `topik-<name>-requires-<child>`, `topik-<parent>-parent-required`, `topik-<attribute>-range`, each with a fixed message per rule family                                 |
| Content limits                   | `topik-content-limit`                                                                                                                                                                            |
| Configuration                    | `topik-config-invalid`                                                                                                                                                                           |

Component and attribute diagnostics also say where the problem is and what the
component schema accepts:

| Field       | Set on                                                                                                                              | Value                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `tag`       | `tag-undefined`, `tag-placement-invalid`, `topik-tag-children`, `topik-tag-placement`, and the attribute IDs                        | The component name                                                                 |
| `attribute` | `attribute-undefined`, `attribute-type-invalid`, `attribute-value-invalid`, `attribute-missing-required`, `topik-<attribute>-range` | The attribute name                                                                 |
| `expected`  | `attribute-undefined`, `attribute-type-invalid`, `attribute-value-invalid`                                                          | The supported attribute names, the required type, or the allowed values of an enum |

Names are kept only when they follow the tag grammar and are at most 64
characters long. `expected` comes from the component schema and holds at most 32
entries. Diagnostics never include an authored attribute value.

Variable diagnostics are listed under
[Variables and conditions](#variables-and-conditions).

### Content limits

Admission refuses oversized or pathological input with a `topik-content-limit`
diagnostic and returns the exact source. The values are exported as
`CONTENT_LIMITS`; lengths are measured in UTF-16 code units.

| Limit                      | Value        | Bounds                                                          |
| -------------------------- | ------------ | --------------------------------------------------------------- |
| `sourceLength`             | 1,000,000    | Source length                                                   |
| `parserSteps`              | 67,108,864   | Superlinear inline parser work per document (see below)         |
| `treeDepth`                | 64           | Nesting of blocks, lists, quotes, components and inline nodes   |
| `treeNodes`                | 50,000       | Authoring tree nodes, including template segments               |
| `dataDepth`, `dataEntries` | 160, 500,000 | Nesting and values in trees, metadata and variable data         |
| `dataStringLength`         | 1,000,000    | Total string length in trees and data, including interpolations |
| `expressionLength`         | 16,384       | Characters in one expression                                    |
| `expressionDepth`          | 32           | Expression nesting                                              |
| `expressionNodes`          | 256          | Nodes in one expression                                         |
| `presentationOutputLength` | 8,000,000    | Escaped code-presentation output                                |

In practice a single paragraph can hold a few thousand emphasis delimiters or
unmatched brackets; split denser text into separate paragraphs. Ordinary prose,
intraword underscores, matched code spans, and links cost no parser work, so
long reference pages and changelogs are limited by source and tree size, not by
markup density.

The `parserSteps` budget charges only syntax whose resolution can grow faster
than its paragraph:

- every possible closing emphasis or strikethrough delimiter costs the number of
  parser events in its paragraph
- an unmatched code-span attempt costs the text it rescans
- a label end costs the label text it rereads plus the events since the latest
  label
- each run of brackets or escapes left as text costs a fraction of its
  paragraph's events

## Edge cases

### Evaluation output

Evaluation omits empty paragraphs, empty marks, and empty components that
require inline children. It also removes any terminal hard break that those
omissions leave at the end of a block, so the evaluated document can be written.

`evaluateDocument` checks that its result can be written faithfully. If
evaluation would produce a structure Markdown cannot represent, such as an empty
task item, it throws `ContentEvaluationError` and leaves the authored document
untouched.

Marks that evaluation brings together merge: `~~a~~{% $e %}~~b~~` with an empty
`e` writes `~~ab~~`.

`transformTopikContent` does not need a Markdown representation, so its render
tree keeps structures that `evaluateDocument` would refuse.

### Heading IDs

Rendering assigns heading IDs from all authored headings before it selects
branches or inserts variable values, matching `analyzeTopikContent`. Headings
in unselected branches therefore also reserve their IDs.

For a stable, descriptive anchor on a heading that contains a variable, write
an explicit ID, such as `## Hello {% $name %} {% #hello %}`.

### Templates

- An empty or literal-only template is still a template, not an ordinary
  string.
- An empty template evaluates to a present, empty value.

## Further documentation

- [Format, normalization, and reference scopes](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)
- [Text and code templates](https://github.com/subtopik/topik/blob/main/docs/content/templates.md)
- [Code presentation](https://github.com/subtopik/topik/blob/main/docs/content/code-presentation.md)
- [Explicit links and plain URLs](https://github.com/subtopik/topik/blob/main/docs/content/autolinks.md)
- [Rendering and migration from content-schema](https://github.com/subtopik/topik/blob/main/docs/content/rendering.md)

## Versions and upgrading

This package is alpha software. The content schema version is `0.2.2`
(`TOPIK_CONTENT_SCHEMA_VERSION`), and `FORMAT_VERSION` is `1`. When you upgrade,
review the canonical output and keep compiler and renderer versions aligned.

The package verifier type-checks and executes every TypeScript example in this
README against the published-package layout.

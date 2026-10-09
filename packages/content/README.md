# @topik/content

Portable Markdown with declarative components, variables, and conditions. This
package provides an mdast authoring tree, validation, lossless source operations,
and a framework-independent render tree. React rendering lives in
`@topik/content-react`; applications own editing, storage, and synchronization.

The package is ESM and requires Node.js 22.12 or later. Install it with your
package manager:

```sh
npm install @topik/content
```

## Validate, format, and render

`compileTopikContent` validates source and produces a reader tree in one pipeline.
It accepts canonical compiler-generated asset references as well as authored
content. Parsing alone checks neither URL nor asset admission policies. Formatting
validates input and output and checks that serialization preserves the authored
content. Failures retain the exact input.

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

`parseDocument` and `validateDocument` check tree structure and component rules.
`writeDocument` serializes a supported authoring tree. ASTs must contain plain
data with independent node objects: cycles, shared nodes, accessors, and executable
values are refused. Use `validateTopikContent` for source admission, including
navigation and asset policies.

## Markdown and components

Supported Markdown includes headings, emphasis, strong and strikethrough marks,
code, lists and task lists, blockquotes, hard breaks, links, images, reference
definitions, tables, and leading YAML frontmatter. Frontmatter is retained but
not rendered. Raw HTML and footnotes are refused. URLs and email addresses remain
text unless expressed as explicit Markdown links or angle-bracket autolinks.

Block tags occupy their own lines; inline tags appear inside prose. Properties
are literal strings, numbers, and booleans; selected built-in text properties also
accept explicit templates. Unsupported syntax is diagnosed instead of silently
discarded.

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

The exported `components` registry contains complete property, placement, and
child constraints. Defaults are applied when reading or rendering; absent authored
properties remain absent when writing.

## Variables and conditions

Evaluation selects branches and inserts variable values as literal text. It does
not execute JavaScript or interpret interpolated Markdown. Save the authored
document to retain variables and every branch.

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

Expressions support scalar literals, variable paths, `equals`, `and`, `or`, and
`not`. Only `false` and `null` are false; `and` and `or` short-circuit. Missing
variables in evaluated paths throw `ContentEvaluationError`. Conditions control
presentation and do not enforce authorization.

Null and empty strings insert no text. Evaluation omits empty paragraphs, empty
marks, and empty components that require inline children. It also removes terminal
hard breaks exposed by those omissions so the evaluated document remains writable.

`evaluateDocument` verifies that its result can be written faithfully. If evaluation
creates an unrepresentable structure, such as an empty task item or adjacent
strikethrough spans, it throws `ContentEvaluationError` and leaves the authored
document untouched. Rendering through `transformTopikContent` does not require a
Markdown representation and retains those structures in its derived render tree.

Rendering assigns heading IDs using all authored headings before selecting
branches or interpolating text, matching `analyzeTopikContent`. Hidden headings
still reserve their IDs. Use explicit IDs, such as `## Hello {% $name %} {% #hello %}`,
when a stable descriptive anchor is needed for a variable heading.

## Text and code templates

Use `t"..."` to interpolate `title` on `callout`, `accordion`, `card`, `tab`,
`step`, and `codeTab`, or `alt`/`caption` on `figure`. Ordinary quoted properties
stay literal. Empty and literal-only templates retain their template identity;
an evaluated empty template remains a present empty value.

Wrap exactly one fenced code block in `{% template code %}` and
`{% /template code %}` on their own block lines. The markers and fence must share
one logical parent, including a `codeTab` body. Empty payloads are valid; nested,
missing, crossing, multi-fence, or indented-code scopes are refused. Language and
metadata remain literal. Templated `mermaid` fences are refused before diagram
dispatch; unknown languages remain ordinary code. Inline code and unwrapped code
blocks stay literal.

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

Inside templates, `{% $path %}` inserts a scalar and `{%%` writes a literal `{%`
opener. Scanning is single-pass: inserted values and escaped literals are never
interpreted as new tokens. Code backslashes are unchanged; attribute templates
retain ordinary quoted-string escapes. Dotted paths use identifier segments;
expressions, functions, defaults, and bracket paths are unsupported.

Strings, finite numbers, and booleans become raw text; null and empty strings
become empty text. Missing/incompatible values and injected C0/DEL controls,
including newlines and tabs, fail visibly. Each substitution is single-line.
Values create no Markdown/HTML structure and receive normal renderer escaping;
authors supply any shell/JSON/language quoting. Inactive branches validate source
without resolving their variables.

URLs, image sources, icons, math, enums, and custom component properties remain
literal-only. Formatting preserves unevaluated templates and every branch;
evaluation produces a separate derived result. See the [template
reference](https://github.com/subtopik/topik/blob/main/docs/content/templates.md)
for complete scope, escape, diagnostic, and source-storage rules.

## Custom components

Add declarative schemas through `config.components`. Built-in schemas cannot be
overridden; `if` and `else` are reserved for conditions and cannot be component names.
Custom runtime functions, partials, and executable property values
are unsupported. Supply the corresponding render component in your application.
Use `ComponentSchema` to type a reusable custom schema; `ComponentDefinition`
additionally describes the built-in validators used by the runtime registry.

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

## Asset rewriting

Rewriting checks all authored branches and retains the original source on failure.
Callbacks run after input admission; exceptions propagate. Keep callbacks free
of side effects because a later replacement can invalidate the entire operation.

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

Images and figure sources accept canonical relative paths or credential-free
HTTPS URLs. Compiler-generated `asset:` references are accepted in rewritten
output; source admission requires `allowCompiledAssetReferences: true` to accept
them. Generic download links require explicit candidate selection or proven file
paths. Custom asset attributes share validation policies but do not extend the
compiler's closed asset-occurrence protocol.

## Further documentation

- [Format, normalization, and reference scopes](https://github.com/subtopik/topik/blob/main/docs/content/content-design.md)
- [Text and code templates](https://github.com/subtopik/topik/blob/main/docs/content/templates.md)
- [Explicit links and plain URLs](https://github.com/subtopik/topik/blob/main/docs/content/autolinks.md)
- [Rendering and migration from content-schema](https://github.com/subtopik/topik/blob/main/docs/content/rendering.md)

The schema version is `0.2.1` and `FORMAT_VERSION` is `1`. This package is alpha
software. Review canonical output when upgrading and keep compiler and renderer
versions aligned. The package verifier type-checks and executes every TypeScript
example above against the published-package layout.

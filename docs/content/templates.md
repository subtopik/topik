---
title: Text and code templates
description: Insert application variables into component text and explicitly scoped code examples.
---

# Text and code templates

A template inserts a value that your application supplies, such as a package
name or version, into a component label or a code example. The value is always
inserted as literal text. This page is for authors who write templates and for
applications that supply their values.

````markdown
{% callout title=t"Install {% $package.name %}" %}
{% template code %}

```sh
npm install {% $package.name %}@{% $package.version %}
```

{% /template code %}
{% /callout %}

{% figure src="./install.png" alt=t"{% $package.name %} installation" caption=t"Version {% $package.version %}" /%}
````

Supply the values through `config.variables` when compiling or rendering. With
`{ package: { name: "example-kit", version: "1.2.3" } }`, the example above
produces the label `Install example-kit` and the code
`npm install example-kit@1.2.3`.

## Template component text

Write a lowercase `t` directly before a double-quoted string to make that
property a template. The same form covers a value that is only a variable and a
value that mixes text and variables:

```markdown
{% accordion title=t"{% $section.name %}" %}
Content for this section.
{% /accordion %}

{% steps %}
{% step title=t"Install {% $package.name %}" %}
Install the package first.
{% /step %}
{% /steps %}
```

Only these properties accept templates:

| Component                                                            | Template properties |
| -------------------------------------------------------------------- | ------------------- |
| `callout`, `accordion`, `card`, `tab`, `step`, `codeTab`, `question` | `title`             |
| `figure`                                                             | `alt`, `caption`    |
| `video`                                                              | `title`, `caption`  |

A quoted string without `t` is literal, even when it contains text that looks
like a variable.

Empty and variable-free templates are still templates:

- `title=t""` is an explicitly empty template.
- `title=t"Install"` is a template with no variables. It keeps the `t` when the
  document is formatted.
- A template that resolves to empty text sets the property to empty text. The
  property does not become absent, and the component default does not apply.

All other properties are literal-only, including URLs, image sources, icons,
math, enums, numbers, booleans, and language identifiers. Properties of custom
component schemas are literal-only. Frontmatter, Markdown link and image
attributes, and fence metadata do not accept templates.

## Template a code block

Place `{% template code %}` and `{% /template code %}` on their own block lines
around exactly one fenced code block. Backtick and tilde fences both work. The
language and fence metadata stay literal, and an empty fenced payload is valid.
Inline code, indented code, and fences outside a scope are literal.

The two markers and the fence must share one logical parent. A parent is one of:

- the document root
- a list item
- a blockquote
- the body of a component that admits blocks
- a conditional branch
- a `codeTab` body

A scope cannot cross those boundaries. Blank lines between the markers and the
fence are allowed; formatting removes them.

Topik refuses a scope with any of these problems:

- a missing marker or an unclosed fence
- more than one fence, or prose between the markers and the fence
- indented code instead of a fence
- a nested scope
- properties on a marker, or a self-closing marker

Markers are case-sensitive. Spaces or tabs may separate `template` and `code`;
the closing slash must sit directly before `template`. Only these exact markers
have this meaning: an application component named `template` or `codeTemplate`
is an ordinary component.

A templated `mermaid` fence is refused, because templates produce displayed code
text and Mermaid fences render as diagrams. Every other language follows
ordinary code handling, including the plain-text display for unknown languages.

## Write variable tokens and literal text

Write a variable as `{% $name %}`, or use a dotted path such as
`{% $package.name %}`. The rules for a token are:

- Each path segment matches `[A-Za-z_][A-Za-z0-9_]*`.
- The segments `__proto__`, `prototype`, and `constructor` are refused.
- Spaces and tabs may surround the variable inside the token.
- Line breaks inside a token, bracket paths, functions, expressions, defaults,
  and nested tokens are not supported.
- Every unescaped `{%` must begin a complete, valid token.

Write **`{%%` for a literal `{%`** inside a template. Each `{%%` becomes one
literal `{%`, and Topik does not scan the result again for tokens:

| Template text                  | Result                                     |
| ------------------------------ | ------------------------------------------ |
| `{% $name %}`                  | Insert the value of `name`                 |
| `{%% $name %}`                 | Display `{% $name %}`                      |
| `{%%%`                         | Display `{%%`                              |
| `C:\Users\{% $name %}` in code | Preserve the backslashes and insert `name` |

There is no backslash escape for templates. Backslashes in code are unchanged.
Attribute templates use the ordinary quoted-string escapes: `\\`, `\"`, `\|`,
`\[`, and `\]`. A standalone `%}`, dollar signs, ordinary braces, and backticks
are literal text.

Formatting writes each variable as `{% $path %}`, escapes literal openers as
`{%%`, and chooses a fence that preserves the code payload.

## Values

Each variable must resolve to a scalar value:

| Value                      | Inserted text         |
| -------------------------- | --------------------- |
| String                     | The string, unchanged |
| Finite number or boolean   | Its text form         |
| `null` or the empty string | Empty text            |
| Missing path               | Refused               |
| Object, array, or function | Refused               |
| Accessor or other non-data | Refused               |

Lookup reads only own data properties of the supplied variables.

A value must be a single line. Values containing C0 control characters or DEL
are refused, including newlines and tabs, even in multiline code. The authored
code around the tokens can contain its normal line breaks.

Topik never parses a value as Markdown, HTML, a component tag, or another
variable token. Rendering escapes the inserted text once, as ordinary text or
attribute content. Templates provide no shell, JSON, or programming-language
quoting: the author must write the quoting the example needs.

## Templates in conditional branches

Topik checks template syntax, paths, locations, and limits in every conditional
branch. It resolves values only in the selected branch, so a variable that is
missing from an inactive branch does not fail evaluation. Templates do not
affect how conditions are evaluated.

## Diagnostics

| Problem                                    | Diagnostic id                     |
| ------------------------------------------ | --------------------------------- |
| Invalid token or unescaped opener          | `topik-template-syntax`           |
| `__proto__`, `prototype`, or `constructor` | `topik-variable-path`             |
| Template in a literal-only property        | `topik-template-location`         |
| Invalid code template scope                | `topik-code-template-structure`   |
| Templated `mermaid` fence                  | `topik-code-template-language`    |
| Variable not supplied                      | `topik-template-variable-missing` |
| Value is not a supported scalar            | `topik-template-variable-type`    |
| Control character in a value or literal    | `topik-template-control`          |

Where available, a template diagnostic includes the `attribute` and the
`variable` path, with bounded length. Diagnostics never include supplied values.

Variables and conditions in body text, outside templates, report
`topik-variable-missing`, `topik-variable-type`, and `topik-variable-control`,
with the same line and `variable` context.

A failed operation produces no usable partial output. Functions that take
source text return `ok: false` with the original source and the diagnostics;
`evaluateDocument` throws `ContentEvaluationError`. The content, data, and
output limits apply to templates, including repeated substitutions.

## Preserve authoring source

Store the unevaluated source or authoring tree, and use it for formatting and
writeback. It holds each template's kind, literal segments, variable paths, and
every conditional branch. Evaluation creates a separate derived result and does
not modify the source. `evaluateDocument` returns a writable derived tree, but
that tree cannot replace the saved authoring document.

Rules for applications and editors:

- Do not save preview values into the source.
- Resource compilation and asset and link rewriting keep templates in
  `content.value`.
- An editor that cannot preserve template syntax should show the exact source
  read-only or refuse a save that would lose it.

## Compatibility

Templates require content schema `0.2.1` or later; the current content schema
version is `0.3.0`. The content schema version is separate from npm package
versions, the resource `apiVersion`, and `FORMAT_VERSION` (`2`).

Keep readers, compilers, and editors on a compatible package cohort before
authoring templates. Do not downgrade documents to evaluated source for an older
reader.

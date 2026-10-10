---
title: Text and code templates
description: Insert application variables into component text and explicitly scoped code examples.
---

# Text and code templates

Templates insert application-supplied scalar values as literal text. Use an
explicit template when a component label or code example needs reader values:

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

Supply the values through `config.variables` when compiling or rendering. For
example, `{ package: { name: "example-kit", version: "1.2.3" } }` produces the
label `Install example-kit` and code `npm install example-kit@1.2.3`.

## Component text

The lowercase `t` directly before a double-quoted string opts that property into
template parsing. Both whole-value and mixed templates use this form:

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

| Component                                                | Template properties |
| -------------------------------------------------------- | ------------------- |
| `callout`, `accordion`, `card`, `tab`, `step`, `codeTab` | `title`             |
| `figure`                                                 | `alt`, `caption`    |

Ordinary quoted strings remain literal, including variable-looking text.
`title=t""` is an explicitly empty template; `title=t"Install"` retains template
identity even without a variable. A template that resolves to empty text remains
a present empty property, rather than becoming absent or restoring a default.

Other properties are literal-only, including URLs, image sources, icons, math,
enums, numbers, booleans, and language identifiers. Custom component schemas also
remain literal-only. Frontmatter, Markdown link/image attributes, and fence
metadata do not accept templates.

## Scoped code

Place `{% template code %}` and `{% /template code %}` on their own block lines
around exactly one fenced code block. Backtick and tilde fences are supported;
the language and fence metadata remain literal. An empty fenced payload is valid.
Inline code, indented code, and fences outside the scope stay literal.

The two markers and fence must share one logical parent: the document root, a
list item, a blockquote, a component body that admits blocks, a conditional branch,
or a `codeTab` body. A scope cannot cross those boundaries. Blank separator lines
are allowed and removed by formatting. Missing markers, unclosed fences, multiple
fences, intervening prose, indented code, nested scopes, marker properties, and
self-closing markers are refused.

Markers are case-sensitive. Spaces or tabs may separate `template` and `code`;
the closing slash stays directly next to `template`. These are special grammar
forms; application components named `template` or `codeTemplate` keep their
ordinary component meaning.

Templated `mermaid` fences are refused before diagram dispatch. Other language
identifiers follow ordinary code handling, including plain text fallback for
unknown languages. Templates produce displayed code text.

## Tokens and literal escaping

Use `{% $name %}` or dotted paths such as `{% $package.name %}`. Path segments
match `[A-Za-z_][A-Za-z0-9_]*`; `__proto__`, `prototype`, and `constructor` are
refused. Spaces and tabs are allowed around the variable inside a token, but
token line breaks, bracket paths, functions, expressions, defaults, and nested
tokens are unsupported. Every unescaped `{%` must begin a complete valid token.

Use **`{%%` to write a literal `{%` opener** inside a template. The scanner
consumes that escape once and never rescans the resulting literal text:

| Template text                  | Result                                     |
| ------------------------------ | ------------------------------------------ |
| `{% $name %}`                  | Insert the value of `name`                 |
| `{%% $name %}`                 | Display `{% $name %}`                      |
| `{%%%`                         | Display `{%%`                              |
| `C:\Users\{% $name %}` in code | Preserve the backslashes and insert `name` |

Code backslashes remain unchanged. Attribute templates retain ordinary quoted
string escapes: `\\`, `\"`, `\|`, `\[`, and `\]`. There is no backslash-based
template escape. Standalone `%}`, dollar signs, ordinary braces, and backticks
are literal text. Formatting writes active variables as `{% $path %}` and escapes
literal openers with `{%%`; it chooses a fence that preserves the code payload.

## Values and diagnostics

Strings insert unchanged; finite numbers and booleans convert to text. Null and
empty strings insert empty text. Lookup uses safe own data properties. Missing or
incompatible paths, objects, arrays, functions, accessors, and non-data values are
refused. Injected C0 control characters or DEL are refused, including newlines
and tabs: each substitution must be single-line even in multiline code. Authored
code may still contain its normal line breaks.

Values are never parsed as Markdown, HTML, component tags, or further variable
tokens. Reader rendering applies normal text/attribute escaping once. Templates
provide no shell, JSON, or programming-language quoting; authors must supply the
quoting appropriate for the example.

Source syntax, paths, locations, and limits are checked in every conditional
branch. Values are resolved only in the selected branch, so a missing variable
in an inactive branch does not fail evaluation. Existing condition truthiness and
short-circuit behavior are unchanged.

Template diagnostics distinguish syntax (`topik-template-syntax`), location
(`topik-template-location`), code structure (`topik-code-template-structure`),
language (`topik-code-template-language`), missing variables
(`topik-template-variable-missing`), incompatible values
(`topik-template-variable-type`), and forbidden controls
(`topik-template-control`). When available, diagnostics include bounded
`attribute` and `variable` path context without exposing supplied values. Failed
operations retain original source and provide no usable partial output. Existing
content/data/output limits also apply to templates and repeated substitutions.

## Preserve authoring source

Keep the unevaluated source or authoring tree for storage, formatting, and
writeback. It retains template kind, literal segments, variable paths, and every
conditional branch. Evaluation creates a separate derived result and does not
mutate that source. `evaluateDocument` returns a writable derived tree, but that
tree cannot replace the saved authoring document.

Changing preview values must not save them into source. Resource compilation and
asset/link rewriting preserve templates in `content.value`. Editors that cannot
preserve the syntax should retain exact source read-only or refuse a lossy save.

Templates require content schema `0.2.1`. This identity is separate from npm
package versions, resource `apiVersion`, and `FORMAT_VERSION` (`1`). Keep readers,
compilers, and editors on a compatible package cohort before authoring templates;
do not downgrade them to evaluated source for an older reader.

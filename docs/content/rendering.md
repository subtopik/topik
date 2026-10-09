---
title: Rendering
description: Render a document in React, supply reader variables, and handle compilation failures.
---

# Rendering

Use `@topik/content-react` to display Topik Markdown in a React application.
It validates source, evaluates variables and conditions, and renders the resulting
reader tree. You can render a single document without compiling a wiki directory.

## Render with the default theme

```sh
npm install @topik/content-react react react-dom
```

Import the stylesheet once in the application's stylesheet entry point:

```ts
import "@topik/content-react/theme/styles.css";
```

The themed component provides the built-in content components:

```tsx
import { TopikContent } from "@topik/content-react/theme";

export function Article() {
  return <TopikContent content={"# Getting started\n\nKeep a **backup**."} />;
}
```

The root `@topik/content-react` entry point also exports `renderTopikMarkdown`
and `renderTopikContent` for applications that own their component mapping.
Pass themed components when using those functions to render the built-in tags:

```tsx
import { renderTopikMarkdown } from "@topik/content-react";
import { defaultTopikComponents } from "@topik/content-react/theme";

export function ArticleWithComponents() {
  return renderTopikMarkdown("# Getting started", {
    components: defaultTopikComponents,
  });
}
```

## Variables

Supply reader values through `config.variables`:

```tsx
import { TopikContent } from "@topik/content-react/theme";

export function Greeting() {
  return (
    <TopikContent
      content="Hello {% $student.name %}."
      config={{ variables: { student: { name: "Ada" } } }}
    />
  );
}
```

Values become literal text. The same context selects conditional branches.
Formatting and storage should use authored source so that variable references
and all alternatives survive. See [Content format](./content-design.md#variables-and-conditions)
for the expression language and evaluation rules.

The same values resolve supported `t"..."` component properties and paired
`{% template code %}` examples. The plain renderer, rich code fallback, syntax
highlighter, and code copy control receive resolved code text. Server rendering
escapes text and properties normally; supply raw scalar values without HTML
pre-escaping. See [Text and code templates](./templates.md) for locations and
escaping. Ordinary quoted properties and unwrapped code remain literal.

## Handle invalid content

The default behavior is to throw `InvalidTopikContentError` when source cannot
be admitted or evaluated. `TopikContent`, `renderTopikMarkdown`, and
`renderTopikContent` use this same behavior, including during server rendering.

Use an explicit placeholder when a reader should see a fallback:

```tsx
import { TopikContent } from "@topik/content-react/theme";

export function Preview({ source }: { source: string }) {
  return (
    <TopikContent
      content={source}
      invalidContent="placeholder"
      invalidContentPlaceholder={() => <p>This content cannot be previewed.</p>}
    />
  );
}
```

The placeholder has alert semantics and does not expose the source or diagnostic
text. Retain the source separately for correction. Use `onDiagnostic` to collect
sanitized compilation diagnostics when the application needs them.

To inspect a result before rendering, compile explicitly:

```tsx
import { compileTopikContent, renderTopikContent } from "@topik/content-react";
import { defaultTopikComponents } from "@topik/content-react/theme";

export function CheckedArticle({ source }: { source: string }) {
  const result = compileTopikContent(source);
  if (!result.ok) return <p role="alert">This content cannot be displayed.</p>;
  return renderTopikContent(result, { components: defaultTopikComponents });
}
```

Compilation returns `ok` and retains the exact `source`. Success adds a reader
`tree`; failure adds diagnostics and has no tree. `@topik/content` exports the
same `compileTopikContent` function for consumers with another rendering framework.

## Rich code, math, and diagrams

`@topik/content-react/rich` adds Shiki syntax highlighting, KaTeX math, and Mermaid
diagrams. Install the optional peers needed by your content:

| Feature           | Peer dependency and supported range |
| ----------------- | ----------------------------------- |
| Code highlighting | `shiki@^4.0.0`                      |
| Math              | `katex@^0.18.2`                     |
| Mermaid           | `mermaid@^11.16.1`                  |

Wrap the themed renderer with the rich provider:

```tsx
import { RichTopikContentProvider } from "@topik/content-react/rich";
import { TopikContent } from "@topik/content-react/theme";

export function RichArticle({ source }: { source: string }) {
  return (
    <RichTopikContentProvider theme="light">
      <TopikContent content={source} />
    </RichTopikContentProvider>
  );
}
```

Import the rich stylesheet as well as the theme stylesheet. When using math,
include CSS and fonts from the same installed KaTeX version as its JavaScript:

```ts
import "@topik/content-react/theme/styles.css";
import "@topik/content-react/rich/styles.css";
import "katex/dist/katex.min.css";
```

Rich components load their peers in the browser. Server rendering emits the
initial fallback or loading state; hydration completes the rich presentation.
Code and math retain plain fallbacks if rendering fails. Mermaid displays a
loading state and falls back to diagram source on failure. Topik initializes
Mermaid with `securityLevel: "strict"`; code sharing that instance must preserve
its configuration and sanitizer.

## Integrate with application URLs

Compiled content may contain generated `asset:` references. Supply `resolveAsset`
to map each generated name to a delivered URL; see [Assets](../resources/assets.md#render-compiled-assets).
Missing or malformed generated references emit an asset diagnostic and omit the
unresolved browser-facing URL.

Use `resolveLink`, `renderLink`, or `onNavigateLink` on `TopikContent` when the
application owns page URLs or client navigation. For a wiki, use the shared
[Navigation helpers](../resources/navigation.md#resolve-navigation-in-an-application)
to resolve source paths before applying the application's route prefix.

`components` overrides change React presentation. Content semantics and permitted
properties remain governed by `config.components`; changing a renderer does not
make unsupported source valid.

## Migrate from content-schema

Replace `@topik/content-schema` imports with `@topik/content`. Configuration uses
`components` and `variables`, with declarative attribute types such as `"string"`
and `"boolean"`. The former Markdoc `tags`, `nodes`, `functions`, and `partials`
configuration does not have a compatibility runtime.

Parse results contain an mdast authoring tree with Topik nodes. Use
`compileTopikContent` for a reader tree instead of passing an authoring AST to a
React renderer. Recompile resources and asset inventories together after a
content-format upgrade; old occurrence mappings must not be reused with newly
compiled documents.

For callers that already own a validated reader tree, `renderTrustedTopikTree`
is available separately. The caller owns validation; the renderer still checks
browser-facing asset and navigation fields. `TopikContent` accepts source strings,
not trusted trees.

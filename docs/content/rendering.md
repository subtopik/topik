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

Compiled document links identify resources through `ref://wiki-page/<name>` or
`ref://guide/<name>`. The name is the destination's exact `resource.name`, not its
route slug. Queries and heading fragments remain on the reference. Authors can
also use this syntax directly; see [Links between pages](../resources/navigation.md#links-between-pages).

Supply `resolveLink` to turn these identities into the application's browser
URLs. Use the resource type and name as the lookup key, and retain the reference's
query and fragment:

```tsx
import { parseTopikResourceReference } from "@topik/content";
import { TopikContent } from "@topik/content-react/theme";

const routes = new Map([
  ["WikiPage/installation", "/docs/install"],
  ["Guide/getting-started", "/learn/start"],
]);

function resolveLink(href: string): string | undefined {
  const reference = parseTopikResourceReference(href);
  if (!reference) return href;
  const route = routes.get(`${reference.type}/${reference.name}`);
  if (route === undefined) return undefined;
  return `${route}${reference.search}${reference.hash ? `#${reference.hash}` : ""}`;
}

export function PublishedArticle({ source }: { source: string }) {
  return (
    <TopikContent
      content={source}
      resolveLink={resolveLink}
      onLinkDiagnostic={(diagnostic) => console.warn(diagnostic.message)}
    />
  );
}
```

The hook is optional for content without resource references. For a `ref://`
target, return a permitted browser URL or `undefined` when the destination cannot
be resolved. Missing hooks, thrown errors, and unsafe or still-unresolved results
omit the `href` and emit `TOPIK_RESOURCE_REFERENCE_UNRESOLVED` through the optional
`onLinkDiagnostic` callback. Malformed references in a trusted tree emit
`TOPIK_RESOURCE_REFERENCE_MALFORMED`. Diagnostics contain a generic message and
the `link.href` or `card.href` slot, without copying the destination or resolver
exception. The renderer keeps link text and card content visible.

References resolve before custom components and `renderLink` adapters receive
their props. Server rendering emits the actual destination URL, so modified
clicks and opening a link in a new tab work. `renderLink` selects the navigation
component; `onNavigateLink` handles ordinary client navigation after resolution.
Neither hook replaces `resolveLink` for a resource reference.

`TopikContentProvider` also accepts `resolveLink`. Pass it directly in the options
for `renderTopikMarkdown`, `renderTopikContent`, and `renderTrustedTopikTree` when
using those lower-level functions. Existing ordinary-link rewriting continues to
use `resolveLink`; returning `undefined` leaves an ordinary URL unchanged.

For wiki route metadata, use the shared
[Navigation helpers](../resources/navigation.md#resolve-navigation-in-an-application).
Astro's `createTopikLinkResolver` builds the same hook from collection entries and
application-supplied route callbacks; Astro loaders retain the compiled references
in each entry's body.

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

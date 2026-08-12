---
title: Rendering
---

# Rendering

## Invalid and unsupported content

Topik source is validated before it is transformed. `compileTopikContent` returns a discriminated
result and retains the exact caller-supplied string in both branches:

```ts
import { compileTopikContent, renderTopikContent } from "@topik/content-react";

const compiled = compileTopikContent(source);
if (!compiled.ok) {
  showSourceForRecovery(compiled.source);
  showDiagnostics(compiled.diagnostics);
  return;
}

const rendered = renderTopikContent(compiled);
```

A failure has no `tree`. Error- or critical-level content is never passed to Markdoc
transformation. Warnings and informational diagnostics may accompany a successful result.

`renderTopikMarkdown`, `renderTopikContent`, and the default `TopikContent` component throw
`InvalidTopikContentError` for a failure unless a safe placeholder is selected explicitly:

```tsx
<TopikContent content={source} invalidContent="placeholder" />
```

The placeholder has alert semantics and never renders transformed children, source, or diagnostic
text. Its presentation can be replaced without changing that boundary:

```tsx
<TopikContent
  content={source}
  invalidContent="placeholder"
  invalidContentPlaceholder={() => <p>This content cannot be previewed.</p>}
/>
```

Server rendering has the same outcomes: the default throws, while the explicit placeholder emits
stable safe markup.

### Trusted transformed trees

`renderTrustedTopikTree` is the deliberately separate escape hatch for callers that already own a
validated Markdoc render tree:

```ts
import { renderTrustedTopikTree } from "@topik/content-react";

const rendered = renderTrustedTopikTree(tree);
```

The caller owns validation when using this API. Post-transform link and Asset sanitization still
applies. A trusted tree cannot be supplied through `TopikContent` props.

## Formatting and rewriting

The public formatter accepts source rather than an AST so it can refuse invalid input without
losing the original spelling:

```ts
import { formatTopikContent, rewriteTopikAssetOccurrences } from "@topik/content-schema";

const formatted = formatTopikContent(source);
if (!formatted.ok) {
  preserveExactly(formatted.source);
} else {
  save(formatted.formatted);
}

const rewritten = rewriteTopikAssetOccurrences(source, (occurrence) =>
  replacements.get(occurrence.position),
);
if (!rewritten.ok) {
  preserveExactly(rewritten.source);
} else {
  save(rewritten.content);
}
```

Both operations validate before formatting or replacement. A failure contains the exact original
source and actionable diagnostics, and contains no normalized or partially rewritten output.

## Migration and compatibility

This API and default-behavior change is breaking under the Topik compatibility policy:

- Callers that expected `compileTopikContent(source)` to return a raw tree must branch on `ok` and
  read `tree` only from the success result.
- Callers that passed a raw tree to `renderTopikContent` must pass the compile result, or use
  `renderTrustedTopikTree` when they independently own validation.
- The former `validate: false` option has no replacement on the normal compile, render, or
  component path. Validation is mandatory.
- Callers that passed an AST to `formatTopikContent` must pass the original source string and handle
  the discriminated result.
- Callers of `rewriteTopikAssetOccurrences` must handle its success and failure branches.

The grammar meaning is unchanged, so `TOPIK_CONTENT_SCHEMA_VERSION` is not changed. Publication
requires a new package compatibility line and the coordinated release, deprecation, and migration
gate. This source change does not publish or bump a package version. The compatibility process,
including deprecation in at least one published release and a migration window of at least 30
calendar days, still applies.

## Navigation helpers

`@topik/schema` exports browser-safe navigation helpers. Consumers should use them instead of reconstructing paths independently.

```ts
import { findFirstWikiPage, resolveWikiContentHref, resolveWikiNavigation } from "@topik/schema";

const resolved = resolveWikiNavigation(wiki.spec.navigation ?? []);
const firstPage = findFirstWikiPage(wiki.spec.navigation ?? []);
const target = resolveWikiContentHref("../overview#setup", currentPage.name, resolved);
```

The resolver provides canonical routes, logical Markdown source paths, page lookup maps, and owning tab/dropdown/group ancestry. Renderers remain responsible for their own URLs and UI components.

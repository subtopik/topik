---
title: Rendering
---

# Rendering

`@topik/schema` exports browser-safe navigation helpers. Consumers should use them instead of reconstructing paths independently.

```ts
import { findFirstWikiPage, resolveWikiContentHref, resolveWikiNavigation } from "@topik/schema";

const resolved = resolveWikiNavigation(wiki.spec.navigation ?? []);
const firstPage = findFirstWikiPage(wiki.spec.navigation ?? []);
const target = resolveWikiContentHref("../overview#setup", currentPage.name, resolved);
```

The resolver provides canonical routes, logical Markdown source paths, page lookup maps, and owning tab/dropdown/group ancestry. Renderers remain responsible for their own URLs and UI components.

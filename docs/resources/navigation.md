---
title: Navigation
description: Map wiki source directories to navigation, routes, and internal links.
---

# Navigation

A wiki's `navigation` lists its pages in reader order. It also defines the groups,
tabs, dropdowns, and external destinations used by a reader application.
The compiler reads pages from the directory containing `wiki.yaml`.

## Match the directory structure

```yaml
id: handbook
title: Handbook
navigation:
  - index
  - type: group
    title: Content
    slug: content
    children:
      - overview
      - next
  - type: group
    title: Resources
    slug: resources
    children:
      - index
      - assets
  - type: link
    title: Source code
    href: https://github.com/subtopik/topik
```

That configuration reads these files:

```text
handbook/
  wiki.yaml
  index.md
  content/
    overview.md
    next.md
  resources/
    index.md
    assets.md
```

| Navigation entry     | Source file           | Route               |
| -------------------- | --------------------- | ------------------- |
| Root `index`         | `index.md`            | `/`                 |
| Content → `overview` | `content/overview.md` | `/content/overview` |
| Resources → `index`  | `resources/index.md`  | `/resources`        |
| Resources → `assets` | `resources/assets.md` | `/resources/assets` |

A container's non-empty `slug` contributes to both the source path and route.
Omit it to make a group organizational only. Empty container slugs are invalid.
A page can also use a path such as `content/overview` directly in navigation;
paths omit the Markdown extension and use lowercase segments separated by `/`.

An `index` page maps to its containing route. Every page must have one canonical
navigation position, and final routes must be unique. Moving a source path can
change both the page's generated resource name and its route.

## Choose navigation containers

- **Groups** organize sidebar pages and can contain nested groups.
- **Tabs** switch between top-level navigation sections. They appear only at the root.
- **Dropdowns** appear at the root or directly inside a tab. They contain sidebar
  groups, pages, and links.

Choose one navigation surface at a given level: tabs, dropdowns, or sidebar
entries. Within a sidebar, groups, pages, and external links can be mixed.
External tabs and dropdowns use `href` instead of `children`; ordinary external
sidebar entries use `type: link`, as in the example above.

## Links between pages

Markdown page links resolve from the source page's directory. From
`content/overview.md`, these links target the next content page and the assets page:

```markdown
[Next](./next.md)
[Assets](../resources/assets.md)
[Asset identity](../resources/assets.md#generated-identity)
```

Fragments refer to the destination's heading IDs. The compiler checks page targets
and fragments against the wiki's navigation and analyzed headings. A file present
on disk is not automatically a wiki page: it must be listed in navigation.

The default link policy reports unresolved targets as errors. The CLI's
`--links warning` or `--links off` changes this check; source URL admission still
applies. Links to supported local downloads are handled as [Assets](./assets.md),
not as wiki pages.

## Resolve navigation in an application

Compiled navigation contains generated page names, page slugs relative to their
containers, and complete `sourcePath` values. Use Topik's resolver to obtain final
routes rather than joining those fields independently:

```ts
import { findFirstWikiPage, resolveWikiContentHref, resolveWikiNavigation } from "@topik/core";
import type { Wiki } from "@topik/schema/wiki/v1";

export function resolvePageLink(wiki: Wiki, currentPageName: string, href: string) {
  const navigation = resolveWikiNavigation(wiki.spec.navigation ?? [], {
    sourceVersion: wiki.spec.sourceVersion,
  });
  return {
    firstPage: findFirstWikiPage(wiki.spec.navigation ?? []),
    target: resolveWikiContentHref(href, currentPageName, navigation),
  };
}
```

The resolver exposes page lookup maps, logical source paths, canonical routes,
and tab/dropdown/group ancestry. The application supplies its URL prefix and
navigation UI. See [Rendering](../content/rendering.md#integrate-with-application-urls)
for the React link hooks.

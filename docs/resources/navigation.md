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

Compilation replaces resolved document destinations with portable resource URIs:

```markdown
[Next](ref://wiki-page/next-page)
[Install](ref://guide/install-guide?view=full#setup)
[Lesson](ref://course-page/setup-lesson#exercise)
```

The authority is the resource kind, `wiki-page`, `guide`, or `course-page`; the
single path segment is the exact destination `resource.name`. A Guide's `spec.slug`,
a WikiPage's navigation route, and a CoursePage's module/page slugs are separate
publishing metadata. Reference names do not depend
on the application's URL prefix. The canonical form uses lowercase kinds and
resource names; query parameters and fragments are retained. `@topik/content`
exports `parseTopikResourceReference`, `serializeTopikResourceReference`, and
`TOPIK_RESOURCE_REFERENCE_VERSION` for this contract.

Authors may write either relative Markdown destinations or `ref://` destinations
directly, including card `href` properties and reference-style Markdown links.
The compiler resolves relative document links against declared source resources,
including CoursePage and Guide targets and links between source kinds in a manifest. Explicit
references identify a resource without depending on its file location. Changing
a resource name requires updating its incoming references; changing only its
public route does not. Use persistent names in versioned source metadata when
references must survive source moves.

The default link policy reports missing local source targets and known invalid
heading fragments as errors. The CLI's `--links warning` or `--links off` changes
these diagnostics; malformed or unsafe URL admission still applies. Links to
supported local downloads retain the existing [Asset](./assets.md) behavior.

### Folder landing pages

A source folder link such as `./files`, `./files/`, or `/files/` selects a declared
`index` or `README` page directly inside that folder. Landing basenames are matched
case-insensitively, so `readme.md` also works. The source readers support `.md` and
`.mdx`; a landing must already be declared by Wiki navigation, Course module pages,
or a declared Guide collection. A nested Guide folder needs its own declared
collection. Files on disk do not automatically become pages.

Exactly one declared landing is required. Multiple candidates (including both
`index` and `README`) report `link-reference-ambiguous`; there is no implicit
priority. A folder without a declared landing reports `link-page-not-found` under
the usual error/warning/off link policy. Use an explicit filename to disambiguate.
Topik never generates pages or directory listings.

Relative folder links use the referring file's directory; root folder links use
its configuration directory. A real directory takes precedence over a same-stem
page alias: `./files` selects `files/index.md`, while `./files.md` selects the
separate file. A trailing slash on a non-Markdown path explicitly requests a
folder, even if that folder is missing or the path names a download. Explicit
Markdown filenames retain their existing trailing-separator compatibility
(`page.md/` still names the file).

Queries and fragments do not alter folder selection. They are copied to the
landing page's normal `ref://wiki-page/...`, `ref://course-page/...`, or
`ref://guide/...` reference; known headings are validated on that page. Cards use
the same folder rule.

An extensionless root URL without a trailing slash still prefers an existing
Wiki/Course public route. Use `/files/` to explicitly select a config-relative
folder. The canonical root URL `/` also retains its declared public route; `./`
selects the referring file's source folder. External URLs remain external. Guide application URLs such as
`/account/settings/` remain browser URLs when they do not name a local folder;
explicit relative folder links such as `./missing/` require a landing.

An explicit reference can point to a resource outside the current compilation.
Topik does not fetch another repository or assume an application namespace. Supply
the optional `referenceTargets` inventory to `compile`, `compileWiki`,
`compileGuides`, or `compileCourse` when other published targets are known:

```ts
import { compileWiki } from "@topik/core";

const result = await compileWiki({
  dir: "./handbook",
  referenceTargets: [
    { type: "Guide", name: "install-guide", headings: ["setup"] },
    { type: "CoursePage", name: "setup-lesson", headings: ["exercise"] },
  ],
});
```

Locally discovered resources take precedence over the supplied inventory. A
reference to a known target is verified against its headings. When the target is
unavailable, or its headings are unavailable for a requested fragment, validation
is deferred and the explicit reference remains in compiled content. Duplicate
inventory entries for one type/name are ambiguous. `result.references` records
each compiled reference's original authored destination, target identity, source
location, and `verified`, `deferred`, or `invalid` status. The publishing
application supplies the final catalogue and must resolve the reference before
emitting a browser link.

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
navigation UI. `resolveWikiContentHref` accepts compiled `ref://wiki-page/<name>`
destinations and retains support for older relative source links. It resolves only
WikiPage references; the application supplies its Guide and CoursePage catalogues
and routes. `resolveCourseNavigation` and `resolveCourseContentHref`, also available
from `@topik/core/course-navigation`, resolve CoursePage references against one
Course's module/page routes while retaining older source-path and route links.
See [Rendering](../content/rendering.md#integrate-with-application-urls) for the
React link hooks and the browser-URL requirement.

Astro loaders expose resource names as entry IDs and publishing routes as
`entry.data.slug`. Build a route resolver from entries without treating slugs as
resource identities:

```ts
import { getCollection } from "astro:content";
import { createTopikLinkResolver } from "@topik/astro";

const resolveLink = createTopikLinkResolver({
  wikiPages: await getCollection("wiki"),
  guides: await getCollection("guides"),
  resolveWikiPage: (entry) => `/docs/${entry.data.slug}`,
  resolveGuide: (entry) => `/learn/${entry.data.slug}`,
});
```

The callbacks can use additional collection metadata to select each route.
Unknown targets, missing route callbacks, and invalid browser URLs return
`undefined`; an optional `onDiagnostic` callback receives a generic unresolved
reference diagnostic. Queries and fragments are applied to the selected route.

For applications combining Markdown with their own resource inputs,
`discoverWikiResources`, `discoverGuideResources`, and `discoverCourseResources`
read authoring metadata and source paths without compiling Assets or resolving
destinations. Merge the
declared inventory, run `compileResourceLinks`, check its diagnostics, then pass
its rewritten resources to `compileAssetResources`. This keeps document targets
from being mistaken for downloads.

## Migrate compiled resources and source snapshots

Compiled WikiPage, Guide, and CoursePage link destinations now use `ref://` rather
than source file paths. Deploy a renderer that resolves these references before
publishing newly compiled content. Existing relative-link resources remain
supported by the Wiki and Course resolvers while applications recompile their
content.

Source inspection retains the original authored destinations and source context
separately from compiled reference URIs. Reviewed writes preserve relative links
and direct authored references where their target meaning remains unchanged.
`SOURCE_WRITER_DESCRIPTOR.references` advances to `source-links-v5`, and its
`provenance` version advances to `7`. Regenerate saved source projects and update
plans from authored source before using them with this writer; do not reuse older
occurrence or provenance snapshots against the new compiled representation.

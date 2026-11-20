---
title: Navigation
description: Map wiki source directories to navigation, routes, and internal links.
---

# Navigation

This page explains how a wiki's `navigation` maps source files to pages and
routes, how links between pages are written and compiled, and how an application
resolves compiled navigation and links into browser URLs. Read it when you author
a wiki or build a reader for compiled Topik content.

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
External tabs and dropdowns use `href` in place of `children`; ordinary external
sidebar entries use `type: link`, as in the example above.

## Links between pages

Write links to other pages as relative Markdown destinations. They resolve from
the source page's directory. From `content/overview.md`, these links target the
next content page and the assets page:

```markdown
[Next](./next.md)
[Assets](../resources/assets.md)
[Asset identity](../resources/assets.md#generated-identity)
```

Fragments refer to the destination's heading and accordion IDs. The compiler
checks page targets and fragments against the wiki's navigation and analyzed
headings and accordions. A fragment that matches a generated ID whose title
other headings or accordions on that page share compiles, but warns with
`link-fragment-positional`, because the ID moves when an earlier heading or
accordion with that title is added or removed. Give a heading an explicit
`{% #id %}`, or an accordion an explicit `id` attribute, instead; see
[Heading anchors](../content/content-design.md#heading-anchors) and
[Accordion anchors](../content/content-design.md#accordion-anchors). A
fragment-only destination such as `#setup` names the same page, so it is checked
for links and cards alike, including cards on course pages. A file present
on disk is not automatically a wiki page: it must be listed in navigation.

The compiler resolves relative document links against declared source resources,
including CoursePage and Guide targets and links between source kinds in a
manifest. Links to supported local downloads compile to Assets; see
[Assets](./assets.md).

### Compiled links are `ref://` references

Compiled WikiPage, Guide, and CoursePage content stores every resolved document
link as a portable resource reference URI, not as a source file path:

```markdown
[Next](ref://wiki-page/next-page)
[Install](ref://guide/install-guide?view=full#setup)
[Lesson](ref://course-page/setup-lesson#exercise)
```

- The authority is the resource kind: `wiki-page`, `guide`, or `course-page`.
- The single path segment is the exact destination `resource.name`.
- Query parameters and fragments are kept.
- The canonical form uses lowercase kinds and resource names.

A reference names a resource, not a URL. A Guide's `spec.slug`, a WikiPage's
navigation route, and a CoursePage's module/page slugs are separate publishing
metadata, and reference names do not depend on the application's URL prefix.
`@topik/content` exports `parseTopikResourceReference`,
`serializeTopikResourceReference`, and `TOPIK_RESOURCE_REFERENCE_VERSION` for this
contract.

Authors can also write `ref://` destinations directly, including in card `href`
properties and reference-style Markdown links. An explicit reference identifies a
resource without depending on its file location. Changing a resource name
requires updating its incoming references; changing only its public route does
not. Use persistent names in versioned source metadata
([Source writing](./source-writing.md#opt-into-source-metadata)) when references
must survive source moves.

### Link diagnostics

By default, a missing local source target or a known invalid heading fragment is
an error. The CLI's `--links warning` reports these as warnings and
`--links off` disables them. Malformed or unsafe URLs are rejected under every
link policy.

### Folder landing pages

A link to a source folder, such as `./files`, `./files/`, or `/files/`, selects that
folder's landing page: the declared `index` or `README` page directly inside it.
The link compiles to the landing page's ordinary `ref://wiki-page/...`,
`ref://course-page/...`, or `ref://guide/...` reference. Topik never generates
pages or directory listings for folders.

A landing page must meet these rules:

- Its basename is `index` or `README`, matched case-insensitively (`readme.md`
  also works), with a `.md` or `.mdx` extension.
- It is declared by Wiki navigation, Course module pages, or a declared Guide
  collection. A nested Guide folder needs its own declared collection, or an
  `include` pattern of its parent collection that selects it. Files on disk do
  not automatically become pages.
- It is the only candidate. Multiple candidates, including both `index` and
  `README`, report `link-reference-ambiguous`; there is no implicit priority. Use
  an explicit filename to disambiguate.

A folder without a declared landing reports `link-page-not-found`, as an error,
warning, or nothing according to the link policy.

Folder paths resolve as follows:

- Relative folder links resolve from the referring file's directory; root folder
  links resolve from its configuration directory.
- `./` selects the referring file's own source folder, and `../` from a nested
  page can select a declared landing at the project root.
- Repeated separators and contained `..` segments are normalized. Paths that
  escape the project are invalid for links and cards.
- A real directory takes precedence over a same-stem page alias: `./files`
  selects `files/index.md`, while `./files.md` selects the separate file.
- A trailing slash on a non-Markdown path always requests a folder, even if that
  folder is missing or the path names a download.
- A trailing separator after an explicit Markdown filename is ignored:
  `page.md/` still names the file.

Root links can also name public routes:

- An extensionless root URL without a trailing slash, such as `/files`, prefers a
  declared Wiki or Course public route. Write `/files/` to select a
  config-relative folder.
- Exact declared public routes take precedence: `/index` selects a declared
  `/index` route, and `/section/index` selects a declared `/section/index` route.
  Only when no exact route exists do these Wiki URLs alias `/` and `/section`.
- A config page with `slug: index` declares its containing route (the root `/` at
  the top level); `slug: index/index` declares `/index`.
- External URLs are external. Guide application URLs such as `/account/settings/`
  are browser URLs when they do not name a local folder. An explicit relative
  folder link such as `./missing/` requires a landing.

Queries and fragments do not affect folder selection. They are copied to the
landing page's reference, and known headings are validated on that page. Cards use
the same folder rules.

### Reference targets outside the compilation

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

- Locally discovered resources take precedence over the supplied inventory.
- A reference to a known target is verified against its headings.
- When the target is unavailable, or its headings are unavailable for a requested
  fragment, validation is deferred and the explicit reference stays in compiled
  content.
- Duplicate inventory entries for one type and name are ambiguous.

`result.references` records each compiled reference's original authored
destination, target identity, source location, and `verified`, `deferred`, or
`invalid` status. The publishing application supplies the final catalogue and
must resolve each reference before emitting a browser link.

## Resolve navigation in an application

Compiled navigation contains generated page names, page slugs relative to their
containers, and complete `sourcePath` values. Use Topik's resolver to obtain final
routes; do not join those fields yourself:

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
navigation UI.

`resolveWikiContentHref` resolves compiled `ref://wiki-page/<name>` destinations
and relative source links. It resolves only WikiPage references; the application
supplies its Guide and CoursePage catalogues and routes.

`resolveCourseNavigation` and `resolveCourseContentHref`, also available from
`@topik/core/course-navigation`, resolve CoursePage references against one
Course's module/page routes. They also accept source-path and route links.

See [Rendering](../content/rendering.md#integrate-with-application-urls) for the
React link hooks and the browser-URL requirement.

### Wiki resolver contract

These rules hold for the same functions imported from `@topik/core` or the
browser-safe `@topik/core/wiki-navigation`.

`resolveWikiNavigation` throws when two pages share a page name, a public route or
a source path. A page without `sourcePath` derives one from its slugs, with an
empty slug read as `index`, and that derived path counts too. Each lookup map
(`pageByName`, `pageByRoute`, `pageBySourcePath`) must name exactly one page so
that a reference, a public URL and a source-relative link each identify one
target. The check is therefore stricter than one on names and routes alone.

`resolveWikiContentHref` resolves `ref://wiki-page/<name>` itself, by page name,
whatever the current page and source version are; other `ref://` types return
`null`. Other hrefs resolve from the current page, and return `null` when it is
unknown. A result has these fields:

| Field    | Meaning                                                                         |
| -------- | ------------------------------------------------------------------------------- |
| `page`   | The resolved page: name, navigation node, route, source path and ancestors.     |
| `route`  | The page's canonical public route, without a leading slash (`""` for the root). |
| `search` | The query with its leading `?`, or `""` when it is absent or empty.             |
| `hash`   | The fragment without its `#`, or `""`. Percent-encoded for every href form.     |

`search` keeps percent-escapes from the href byte-for-byte, including non-UTF-8
and malformed ones such as `?mode=%FF` or `?q=%`. Characters a URL cannot hold raw
are percent-encoded as the WHATWG URL parser encodes them, so `./page.md?a=é`
gives `?a=%C3%A9`. A `ref://` link whose fragment does not decode as UTF-8, such
as `#%FF`, is rejected.

Pass the Wiki's `spec.sourceVersion` to `resolveWikiNavigation`; it changes how
links match:

- With `sourceVersion: 1`, relative links and links ending in `.md`, `.mdx` or
  `.markdown` match source paths, and extensionless root links match public
  routes.
- Without a source version, the same source-relative links match the public route
  derived from their path, with the extension and a trailing `index` removed, so
  they resolve only where routes mirror the source layout.

A folder link, ending in `/`, `.` or `..` or naming a declared folder, selects the
folder's single `index` or `README` page by the [folder landing
rules](#folder-landing-pages) and returns `null` when there is none or more than
one. An explicit Markdown filename such as `./files.md` selects that file.
An extensionless root link such as `/folder` is a public-route link first: a page
with exactly that route wins, and the folder rule applies only when no route
matches. `/folder/` and `./folder` always use the folder rule.

Href paths are percent-decoded once before matching, so `next%20page.md` and
`next page.md` name the same source. Source paths may contain `%`, `#`, `?` or
spaces. A path with a malformed escape, such as `/%ZZ`, returns `null`.

### Resolve links in Astro

Astro loaders expose resource names as entry IDs and publishing routes as
`entry.data.slug`. Build a route resolver from entries without treating slugs as
resource identities. `@topik/astro` is a private workspace package and is not
published to npm:

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
Queries and fragments are applied to the selected route. Unknown targets, missing
route callbacks, and invalid browser URLs return `undefined`; an optional
`onDiagnostic` callback receives a generic unresolved reference diagnostic.

### Compile links for your own resource inputs

Applications that combine Markdown with their own resource inputs compile links
in this order:

1. Read authoring metadata and source paths with `discoverWikiResources`,
   `discoverGuideResources`, and `discoverCourseResources`. These do not compile
   Assets or resolve destinations.
2. Merge the declared inventory and run `compileResourceLinks`.
3. Check its diagnostics.
4. Pass its rewritten resources to `compileAssetResources`.

Resolving links before Assets keeps document targets from being mistaken for
downloads.

## Migrate compiled resources and source snapshots

Resources compiled by earlier versions of Topik store WikiPage, Guide, and
CoursePage link destinations as source file paths; current compilation emits
`ref://` references. To upgrade:

1. Deploy a renderer that resolves `ref://` references before publishing newly
   compiled content. The Wiki and Course resolvers also accept relative-link
   resources, so previously compiled content keeps working while applications
   recompile it.
2. Regenerate saved source projects and update plans from authored source.
   `SOURCE_WRITER_DESCRIPTOR.references` is `source-links-v5` and its
   `provenance` version is `7`; do not reuse occurrence or provenance snapshots
   from earlier versions against the current compiled representation.

Authored source does not change. Source inspection keeps the original authored
destinations and source context separately from compiled reference URIs, and
reviewed writes preserve relative links and direct authored references where
their target meaning is unchanged.

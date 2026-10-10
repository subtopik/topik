---
title: Source writing
description: Plan reviewed changes to portable Guide, Wiki and Course source projects.
---

# Source writing

`@topik/core` can inspect a complete source tree and plan Guide, Wiki, WikiPage,
Course, CourseModule, CoursePage and Person changes. These APIs return candidate
files; they do not edit a checkout, create a Git commit, publish content or
authorize a write. Applications decide when and how to apply a plan.

## Opt into source metadata

Add `sourceVersion: 1` to a declared collection or Wiki configuration to interpret
the extended metadata. The root manifest's `version: 1` controls discovery only.
Unsupported source versions fail compilation. Without this opt-in, existing
opaque `id`, `slug`, `labels`, `inheritTags` and collection `persons` fields keep
their previous meaning.

Versioned Guide and WikiPage frontmatter supports a stable `id`, `title`,
`description` and string-valued `labels`. Guides also support `slug`, ordered
`authors`, `tags` and `inheritTags: false` to replace inherited collection tags.
Absent, null and empty metadata values retain their resource-schema meanings.
A collection's `persons` contains records with `id`, optional `labels` and the
complete Person `spec` (`name`, optional `email` and `bio`). Guide authors must
resolve to declared Persons. A Wiki configuration supports `labels`, and its
compiled resource carries `spec.sourceVersion: 1`.

Versioned Wiki page navigation can specify `source`, a config-relative Markdown
path without its extension, separately from the public `slug`. Relative content
links resolve from the current page's source directory. Root-relative links with
a Markdown extension address source paths; extensionless root links address
public routes. Hidden pages remain valid targets. Readers must pass the Wiki's
source version to `resolveWikiNavigation`.

`sourceVersion` versions the interpretation of authored files, not a Wiki's
revision or its resource `apiVersion`. A Wiki groups page identities into
navigation; its pages carry the content. Source coordinates connect that
navigation to authored files.

Code presentation is independently admitted by attributes on each fenced code block and
content grammar capability. `sourceVersion: 1` does not activate it. Store its
unevaluated source, template identity and all conditional branches; preview
values and fold/wrap state create no saved changes. A metadata-only presentation
edit preserves the code payload and complementary source bytes. Filename/title
labels never create Asset references or source-file authority.

For example:

```yaml
id: handbook
title: Handbook
sourceVersion: 1
navigation:
  - type: page
    slug: getting-started
    source: pages/start
```

With `id: intro` in `pages/start.md` frontmatter, the compiled page node has
`page: intro`, `slug: getting-started` and `sourcePath: pages/start`. Those fields
represent the page identity, public route and config-relative Markdown location,
respectively. Source paths omit the extension and remain portable; they are not
absolute filesystem paths. Moving the file need not change its identity or URL.

## Course sources

A manifest declaration with `kind: course` selects a Course configuration.
Course source files use the new `sourceVersion: 1` grammar explicitly:

```yaml
id: learning
title: Learning
slug: learning
sourceVersion: 1
modules:
  - id: foundations
    title: Foundations
    slug: foundations
    order: 0
    pages:
      - lessons/start
```

The declaration reads `lessons/start.md` or `lessons/start.mdx` relative to the
configuration directory. Each page has explicit frontmatter:

```markdown
---
id: first-lesson
title: First lesson
slug: introduction
order: 0
---

# First lesson
```

The configuration supplies the Course and module metadata and each page's module
membership. Markdown supplies the page metadata and body. Course and module
descriptions distinguish absence from null; labels are string maps. Course and
page authors refer to Persons declared in the configuration's `persons` list.
Module and page `order` values are explicit nonnegative integers. IDs remain
stable independently of file names, public slugs and ordering.

Relative links resolve against a page's source path. Extensionless root links
address public module/page routes such as `/foundations/introduction`; root links
with a Markdown extension address source paths. Compilation preserves query
strings and fragments and validates targets and headings. Images and downloads
use the shared project Asset pipeline and the Course's local `assets.directory`.

Course source context is separate from the Course resource. Inspection returns
`courseContexts`, keyed by `Course/<id>`, containing the module/page routes and
source positions. Retain that immutable context with saved content and pass it as
`courseReferenceContexts["CoursePage/<id>"]` when planning or initializing changes.
This preserves a saved link's target when modules, routes or files move; missing
or incomplete required context blocks planning. Applications can import the
browser-safe resolver from `@topik/core/course-navigation`.

## Inspect and plan

```ts
import { readSourceProject, planSourceUpdates, type SourceTreeFile } from "@topik/core";

async function prepareTitleChange(verifiedPackageCohortSha256: string) {
  const file = (path: string, source: string): SourceTreeFile => ({
    path,
    mode: "100644",
    bytes: new TextEncoder().encode(source),
  });
  const project = await readSourceProject({
    tree: [
      file(
        ".topik.yaml",
        "version: 1\nnamespace: example/docs\nsources: [{kind: collection, config: guides/collection.yaml}]\n",
      ),
      file("guides/collection.yaml", "id: guides\ntitle: Guides\nsourceVersion: 1\n"),
      file(
        "guides/start.md",
        "---\nid: getting-started\ntitle: Original\ncustom: retain\n---\n# Original\n",
      ),
    ],
  });
  const desired = structuredClone(project.compilation.resources);
  const guide = desired.find(
    (resource) => resource.type === "Guide" && resource.name === "getting-started",
  );
  const document = project.documents.find((entry) => entry.resource === "Guide/getting-started");
  if (!guide || guide.type !== "Guide" || !document) throw new Error("Expected the selected Guide");
  guide.spec.title = "Getting started";

  // This local example owns the supplied tree and admits only the selected Markdown file.
  const { path, sha256, mode } = document;
  const result = await planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: verifiedPackageCohortSha256,
    desiredResources: desired,
    operations: [{ kind: "update", resource: "Guide/getting-started" }],
    authority: {
      resources: ["Guide/getting-started"],
      exclusive: [{ path, sha256, mode }],
      shared: [],
      create: [],
    },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

// Runnable fixture token only. Applications supply their verified package-cohort digest.
const plan = await prepareTitleChange("a".repeat(64));
if (plan.changes.length !== 1 || plan.changes[0].path !== "guides/start.md") {
  throw new Error("Expected only the selected Markdown file to change");
}
const source = new TextDecoder().decode(plan.changes[0].candidate!.bytes);
if (!source.includes('title: "Getting started"') || !source.endsWith("# Original\n")) {
  throw new Error("Expected the title edit to preserve the original body");
}
```

The package-cohort digest identifies the independently verified installed package
set; a correctly shaped string alone is not that verification. Hosted applications
must obtain write authority from their authenticated connection and review evidence.
Inspection supplies ranges and hashes, but does not itself authorize using them.
For a shared Wiki title edit, admit only its configuration's `title` field evidence;
do not grant every configuration field merely because inspection returned it.

Inventory entries contain a portable path, original regular Git mode and exact
`Uint8Array` bytes. Inspection loads only the exact root `.topik.yaml`, compiles
every declaration with its manifest namespace, and returns original document
and configuration provenance with hashes and UTF-8 byte ranges. Document
`fieldOrigins` distinguish explicit, inherited, derived and default values.
`sourceContext` records the config-local path and references its portable Wiki
snapshot in `wikiContexts`; `references` retain navigation occurrence positions
and resolved stable targets, including query and fragment semantics.
Document `assetReferences` records its exact compiled Asset closure so callers
can retain references owned by unchanged siblings without reparsing content.

Changes require explicit create, update, delete or move operations. Omission is
not deletion. `authority.resources` admits every resource affected by authored
changes or shared-reference changes. Existing Markdown needs exact exclusive-file authority; new paths
need admitted absence. Configurations and the root manifest use independently
admitted field ranges and insertion anchors against their exact base bytes and
mode. A proposed selector cannot grant its own authority. In an isolated runner
integration, the trusted coordinator must independently admit the scope and
replay shared byte edits, checking that all bytes outside it remain identical.

Unchanged files remain byte-for-byte identical. Metadata edits retain the exact
body, unrelated keys, comments, newline spelling and mode. Body edits use the
public content writer with semantic checks. A move persists stable identity,
repairs navigation and incoming references, and requires authority for every
derived edit. `derivedRepairs` and `assetMappings` are part of reviewable output.
Retain the source context and referenced `wikiContexts` snapshot with saved
authoring content across acknowledgments. Supply that saved Wiki as each page's
`referenceContexts` input so later saves still resolve references after moves.
These contexts also apply during initialization and source addition. A native
editor can retain its original portable Wiki navigation before assigning source
paths; it must supply that grammar with the saved body. Every initialized page
needs an explicit navigation/source association; unlisted pages are refused.
Every saved context must contain the corresponding page identity, including newly
created pages. An unresolved internal reference blocks planning instead of acquiring
a target from a newer navigation snapshot.

Browser readers can import the same resolver from `@topik/core/wiki-navigation`
without loading compiler or filesystem modules. Query strings, fragments, hidden
targets and source-versus-route semantics follow the same contract.
`resolveWikiContentReference` classifies an already-admitted compiled href as a
page, external URL, Asset, or unresolved reference. Readers can refuse unresolved
references without hiding failures behind the nullable `resolveWikiContentHref` API.
Local media/download paths need source-inventory classification and compilation to
Asset references first; a filename extension alone cannot prove a download exists.

New media requires exact bytes, digest, desired Asset and declared configuration
in `media`. It is written into that configuration's `assets.directory`; existing
paths are never overwritten, and unused files are not garbage-collected.
`assetReferenceContexts` can map names in a saved body to separately admitted
media selections. This transport mapping changes the candidate compilation,
while the saved graph remains sealed in its original name space. Reusing media
requires exact prior identity and byte provenance; changed bytes require a new
path. Context inputs are included in the plan seal.

The whole candidate tree is recompiled and compared with the complete desired
graph, including unchanged siblings and shared assets. A successful plan binds
the writer descriptor, package cohort, base tree, saved graph, candidate tree,
operations, admitted authority and exact changes. Failures return diagnostics
without an applicable plan. Semantic no-ops return no file changes and should
not produce a Git commit.
The writer descriptor includes the actual `contentSchema` and `FORMAT_VERSION`
identities. Saved contexts with a different identity visibly refuse update plans
and declaration additions; inspect the original source again with the intended
compatible cohort before preparing an edit. Resource/Asset protocol identities
remain independently admitted and are preserved.
Known compiler failures retain their code, safe path, and available line or source
declaration context. Content diagnostic lines refer to the body after frontmatter.
Diagnostic output is bounded to 64 entries and 8 lines per entry; unexpected
exception details remain private.

## Initialize or add a declaration

`initializeSourceProject` requires explicit initialization intent, a chosen
namespace, a complete occupied-path inventory proving project absence, and
admitted create paths. An existing empty manifest is a project; an invalid
manifest or unresolved source configuration cannot be treated as absence.
Unrelated files are preserved and every generated path uses no-overwrite rules.
Optional `documentPaths` assigns explicitly admitted Guide filenames separately
from their public slugs, including safe names for reserved or long slug spellings.
It also assigns explicit CoursePage filenames. Wiki filenames follow each page's
explicit navigation `sourcePath` instead. A Course initializer writes its Course
and module configuration plus explicitly identified page Markdown and media.

`addSourceToProject` handles a valid existing manifest, including `sources: []`.
It requires a new source intent and independently admitted `sources/+` root
insertion evidence. The namespace, existing declaration order and untouched
source bytes remain exact. Both operations generate configs, stable page IDs,
Markdown and supplied media that compile without application-specific data.

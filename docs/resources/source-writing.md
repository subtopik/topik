---
title: Source writing
description: Plan reviewed changes to portable Guide, Wiki and Course source projects.
---

# Source writing

This page is for applications that edit Topik source projects, such as hosted
editors and review tools. `@topik/core` can inspect a complete source tree and plan
Guide, Wiki, WikiPage, Course, CourseModule, CoursePage and Person changes. These
APIs return candidate files; they do not edit a checkout, create a Git commit,
publish content or authorize a write. Applications decide when and how to apply a
plan.

## Source metadata

Collections, Wikis and Courses read stable identities, routes and metadata from
their configuration and frontmatter. For example:

```yaml
id: handbook
title: Handbook
navigation:
  - type: page
    slug: getting-started
    source: pages/start
```

With `id: intro` in `pages/start.md` frontmatter, the compiled page node has
`page: intro`, `slug: getting-started` and `sourcePath: pages/start`. Those fields
represent the page identity, public route and config-relative Markdown location,
respectively. Source paths omit the extension and are portable; they are not
absolute filesystem paths. Moving the file need not change its identity or URL.

### Guide and WikiPage frontmatter

Guide and WikiPage frontmatter supports a stable `id`, `title`,
`description` and string-valued `labels`. Guides also support `slug`, ordered
`authors`, `tags` and `inheritTags: false` to replace inherited collection tags.
Absent, null and empty metadata values have the same meanings as in the resource
schema. Other frontmatter keys are kept in the file and not interpreted.

### Persons and Wiki configuration

A collection's `persons` contains records with `id`, optional `labels` and the
complete Person `spec` (`name`, optional `email` and `bio`). Guide authors must
resolve to declared Persons. A Wiki configuration supports `labels`.

### Wiki page sources and links

A Wiki groups page identities into navigation; its pages carry the content.
Source coordinates connect that navigation to authored files. Versioned Wiki page
navigation can specify `source`, a config-relative Markdown path without its
extension, separately from the public `slug`.

- Relative content links resolve from the current page's source directory.
- Root-relative links with a Markdown extension address source paths.
- Extensionless root links address public routes; an explicit trailing slash
  selects a source folder landing.
- Hidden pages are valid targets.

Readers must pass the Wiki's source version to `resolveWikiNavigation`.

## Course sources

A manifest declaration with `kind: course` selects a Course configuration:

```yaml
id: learning
title: Learning
slug: learning
modules:
  - id: foundations
    title: Foundations
    slug: foundations
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
---

# First lesson
```

The configuration supplies the Course and module metadata and each page's module
membership. Markdown supplies the page metadata and body.

- A page requires `id`, `title` and `slug`. It may also set
  `description` (at most 1024 characters), `authors` and string-valued `labels`.
- Course, module and page descriptions distinguish absence from null; labels are
  string maps.
- Course and page authors refer to Persons declared in the configuration's
  `persons` list.
- Order is list position, as in Wiki navigation: modules appear in the order of
  `modules`, and pages in the order of their module's `pages`. Compiled resources
  carry the same order as `Course.spec.modules` and `CourseModule.spec.pages`. An
  `order` key left from an older source fails with `course-order-removed`
  naming the field.
- IDs are stable independently of file names, public slugs and ordering.

### Course links

Relative links resolve against a page's source path. Extensionless root links
address public module/page routes such as `/foundations/introduction`; root links
with a Markdown extension address source paths. Compilation rewrites declared
document links to portable `ref://course-page/<name>`, `ref://wiki-page/<name>`, or
`ref://guide/<name>` identities, preserves query strings and fragments, and
validates known targets and headings. Images and downloads use the shared project
Asset pipeline and the Course's local `assets.directory`.

A CoursePage reference uses the exact page resource name, not its module/page
route. It can target a page in the current Course or in another declared Course.

### Course reference contexts

Course source context is separate from the Course resource. Inspection returns
`courseContexts`, keyed by `Course/<id>`, containing the module/page routes and
source positions. Keep that immutable context with saved content and pass it as
`courseReferenceContexts["CoursePage/<id>"]` when planning or initializing changes.
The context preserves a saved link's target when modules, routes or files move;
missing or incomplete required context blocks planning.

Edited source-relative or route links need this context when their routing
context changes. `ref://` identities carry their own target and do not. Source
writes restore the original authored links where their meaning is unchanged and
repair their destinations when files or routes move. Applications can import the
browser-safe resolver from `@topik/core/course-navigation`.

## Inspect and plan

Read the tree with `readSourceProject`, edit a copy of its compiled resources,
then ask `planSourceUpdates` for the file changes:

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
      file("guides/collection.yaml", "id: guides\ntitle: Guides\n"),
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

### What inspection returns

Inventory entries contain a portable path, original regular Git mode and exact
`Uint8Array` bytes. Inspection loads only the exact root `.topik.yaml` and
compiles every declaration with its manifest namespace. It returns:

- original document and configuration provenance, with hashes and UTF-8 byte
  ranges;
- document `fieldOrigins`, which distinguish explicit, inherited, derived and
  default values;
- `sourceContext`, which records the config-local path and references its
  portable Wiki snapshot in `wikiContexts`;
- `references`, which hold navigation occurrence positions and resolved stable
  targets, including query and fragment semantics;
- document `assetReferences`, the exact compiled Asset closure of each document,
  so callers can keep references owned by unchanged siblings without reparsing
  content.

### Authority

The package-cohort digest identifies the independently verified installed package
set; a correctly shaped string alone is not that verification. Hosted applications
must obtain write authority from their authenticated connection and review
evidence. Inspection supplies ranges and hashes, but does not itself authorize
using them. For a shared Wiki title edit, admit only its configuration's `title`
field evidence; do not grant every configuration field merely because inspection
returned it.

Changes require explicit create, update, delete or move operations. Omission is
not deletion. The plan admits a change only with matching authority:

- `authority.resources` admits every resource affected by authored changes or
  shared-reference changes.
- Existing Markdown needs exact exclusive-file authority; new paths need admitted
  absence.
- Configurations and the root manifest use independently admitted field ranges
  and insertion anchors against their exact base bytes and mode.
- A proposed selector cannot grant its own authority.
- Admitting a field's value also admits edits of its own items and nested fields
  inside that value, so admitting `navigation` covers page additions and removals
  in the list.

In an isolated runner integration, the trusted coordinator must independently
admit the scope and replay shared byte edits, checking that all bytes outside it
are identical. `@topik/core` exports `verifySharedEdits` and
`replaySourceByteEdits` for this, and `SourcePlanningError` and `SourceTreeError`
for their failures.

### How edits are written

Unchanged files are byte-for-byte identical. Metadata edits keep the exact body,
unrelated keys, comments, newline spelling and mode. A changed value is written as
JSON-compatible YAML in place of the old value, so a block list becomes an
indented flow list such as `tags:` followed by `  ["a"]`; an empty value such as
`description:` takes its new value after the colon. Removing every item of a list
leaves an empty `[]` list; the key is not deleted.

List edits keep the entries they do not change. Person, module and Course page
records are added or removed individually, and a Course page whose file moves
keeps its entry in its module's `pages` list.

A Course's `modules` and each module's `pages` change the way Wiki navigation
does, below. A new page or module is listed in its parent resource, so adding
one is an update of that parent too, as adding a Wiki page is an update of the
Wiki. Each module record is written from its resource, so a rewrite loses what
the resource does not carry:

- Appending a page or module, removing one, or putting a page in the place of a
  removed one edits the list in place.
- Moving a module to the end, as in swapping two modules, removes its entry and
  appends it as one flow mapping. That drops the comments and unrecognized keys
  in the moved module.
- Inserting a page before kept pages rewrites that module's `pages` as one flow
  list.
- Inserting a module before kept modules, or any other module order that
  removals and appends cannot reach, rewrites all of `modules` as one flow list.
  That drops the comments and unrecognized keys in every module.

When a list is rewritten as one value, the authority must admit that list's
value, not only its insertion anchor.

Wiki navigation edits work the same way at every nesting level: removed entries
are deleted in place, changed entries are edited in place and added entries are
appended to the end of their list as flow mappings. A change that needs an added
entry before an unchanged one, or that combines additions and removals between
the same unchanged entries, rewrites that one list as a single flow value, which
drops the comments and shorthand spellings inside it.

Body edits use the public content writer with semantic checks, so equivalent
inline mark nestings from an editor are written in one
[canonical spelling](../content/content-design.md#inline-mark-nesting).

A move persists stable identity, repairs navigation and incoming references, and
requires authority for every derived edit. `derivedRepairs` and `assetMappings`
are part of reviewable output.

### Code presentation

[Code presentation](../content/code-presentation.md) is enabled by attributes on
each fenced code block and by the content grammar capability. The writer stores its unevaluated source, template identity
and all conditional branches. Preview values and fold/wrap state create no saved
changes. A metadata-only presentation edit preserves the code payload and the
surrounding source bytes. Filename and title labels never create Asset references
or source-file authority.

### Saved Wiki contexts

Keep the source context and its referenced `wikiContexts` snapshot with saved
authoring content across acknowledgments. Supply that saved Wiki as each page's
`referenceContexts` input so later saves still resolve references after moves.

- These contexts also apply during initialization and source addition.
- A native editor can keep its original portable Wiki navigation before assigning
  source paths; it must supply that grammar with the saved body.
- Every initialized page needs an explicit navigation/source association;
  unlisted pages are refused.
- Every saved context must contain the corresponding page identity, including
  pages being created.
- An unresolved internal reference blocks planning; it never acquires a target
  from a later navigation snapshot.

### Folder links and link repairs

Folder links select one declared `index`/`README` landing page, including in
dotted directories, and compile to ordinary page references. Missing or ambiguous
landings are unresolved content links, never directory listings. See [folder
landing rules](./navigation.md#folder-landing-pages) for path, route and
declaration precedence. File downloads keep their Asset semantics.

A saved folder spelling is kept while it identifies the same page. Moving a
landing, adding a competing landing, or creating a directory through a page move
or media upload can require an incoming link repair. Such a repair needs both the
referring resource's authority and exact file authority, independently of
authority over the moved page or new upload. Repeated saves of the repaired
candidate produce no further changes.

### Media

New media requires exact bytes, digest, desired Asset and declared configuration
in `media`. It is written into that configuration's `assets.directory`. Existing
paths are never overwritten, and unused files are not garbage-collected.

The destination is `<assets.directory>/<stem>-<hash><extension>`, where the hash
is the first eight hexadecimal digits of the SHA-256 of the selection's Asset
name. `sourceMediaPath({ assetDirectory, filename, name })` returns that path, so
a caller that must admit the path in `create` or `createPaths` does not need its
own copy of the rule. `assetDirectory` is manifest-relative. For
`planSourceUpdates` it is the `assetDirectory` that source provenance reports
for the configuration. For a source being initialized or added it is the
configuration's directory joined with the intent's `assetDirectory`, which
defaults to `_assets`.

`assetReferenceContexts` can map names in a saved body to separately admitted
media selections. This transport mapping changes the candidate compilation, while
the saved graph stays sealed in its original name space. Reusing media requires
exact prior identity and byte provenance; changed bytes require a new path.

### Plan validation

The whole candidate tree is recompiled and compared with the complete desired
graph, including unchanged siblings and shared assets. A successful plan binds
(seals) the writer descriptor, package cohort, base tree, saved graph, candidate
tree, operations, admitted authority, context inputs and exact changes. Failures
return diagnostics without an applicable plan. Semantic no-ops return no file
changes and should not produce a Git commit.

The writer descriptor includes the actual `contentSchema` and `FORMAT_VERSION`
identities. Saved contexts with a different identity visibly refuse update plans
and declaration additions; inspect the original source again with the intended
compatible cohort before preparing an edit. Resource/Asset protocol identities
are admitted independently and preserved.

### Paths of new documents

A `create` operation without a `path` gets a path derived from the resource:
`<source directory>/<slug>.md` for a Guide or Course page and
`<source directory>/<name>.md` for a Wiki page. When that path is occupied, the
planner appends a hyphen and the first eight hexadecimal digits of the SHA-256
of the resource name, such as `docs/install-1e142e62.md`.

- `newSourceDocumentPath({ directory, resource, occupied })` returns the path the
  planner will choose. `occupied` is every path of the project tree plus the
  paths given to earlier operations of the same plan, in operation order.
  `sourceDocumentPathCandidates(directory, resource)` returns both spellings.
- `pathCollisions: "refuse"` on `planSourceUpdates`, `initializeSourceProject`
  and `addSourceToProject` turns the rename into the diagnostic
  `source-path-collision`, which names the resource and the occupied path. The
  default, `"rename"`, keeps the behaviour above, with the same bytes and plan
  digest as before the option existed.
- An explicit `path`, or an entry in `documentPaths`, is never renamed: an
  occupied explicit path always fails.

`initializeSourceProject` and `addSourceToProject` derive paths differently, and
`initialSourceDocumentPath` returns them:

| Source     | Path of a document without a `documentPaths` entry              |
| ---------- | --------------------------------------------------------------- |
| Collection | `<directory>/<slug>.md`                                         |
| Wiki       | `<directory>/<sourcePath>.md`, from the page's navigation entry |
| Course     | `<directory>/<module slug>/<page slug>.md`                      |

These calls never rename against the existing tree: a derived path that is
occupied fails. The one rename is between two new Guides of the same call that
derive the same path, where the later one gets the hash spelling unless
`pathCollisions` is `"refuse"`.

### Diagnostics

Known compiler failures keep their code, safe path, and available line or source
declaration context. Content diagnostic lines count from the top of the file,
frontmatter included.
Diagnostic output is bounded to 64 entries and 8 lines per entry.

Unexpected exception details stay private. A generic fallback diagnostic keeps the
original exception only as a non-enumerable `cause` for in-process debugging, so
serialized diagnostics never include it.

`code` is typed as `SourcePlanDiagnosticCode`, the union of every code the
planners raise, or the ID of a compiler diagnostic passed through unchanged.
`sourcePlanDiagnosticCategory(code)` gives each code one coarse category, so a
consumer can map diagnostics by category and stay correct when codes are added:

| Category          | Meaning                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `request`         | The operations, intent or desired resources contradict each other or are incomplete.     |
| `mapping`         | A resource has no declared source to write to, or its source record is unusable.         |
| `authority`       | The caller did not show the current bytes of a file the plan changes or creates.         |
| `scope`           | The plan would change a resource or shared file the caller did not admit.                |
| `stale`           | The pinned tree is not the tree the project was read from.                               |
| `path`            | A requested or derived file path is occupied or not portable.                            |
| `reference`       | A link or reference cannot be kept or resolved. Compiler `link-…` IDs are in this group. |
| `asset`           | Supplied media bytes or names do not match the desired Assets.                           |
| `unrepresentable` | The desired value has no source form.                                                    |
| `validation`      | The written source does not compile. Every other compiler ID is in this group.           |
| `tree`            | The supplied tree is over a limit or holds unsafe paths.                                 |
| `incompatible`    | The saved project was read by another writer or package cohort.                          |
| `internal`        | The writer failed unexpectedly. Nothing the author wrote is known to be wrong.           |

An unexpected exception is reported with a general code such as
`source-validation-failed` and a non-enumerable `cause`. Pass the diagnostic
object itself to `sourcePlanDiagnosticCategory`, before serializing or copying
it, to get `internal`; a bare code or a copy reads as `validation`.

`readSourceProject` and `snapshotSourceTree` throw `SourceTreeError` for an
invalid or oversized tree, with the same diagnostic on its `diagnostic`
property. The three planners return it in their result.

Some codes worth handling by name:

| Code                       | Returned when                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-tree-too-large`    | The tree has more than 10,000 files, a file over 256 MiB, or more than 512 MiB in total. `limit`, `count` and `unit` (`files` or `bytes`) say which bound was exceeded and by how much. |
| `source-tree-invalid`      | Planning, initialization or source addition receives a tree with duplicate, unsafe or colliding paths, or entries that are not regular files.                                           |
| `source-path-invalid`      | An explicit create or move `path` is not a portable project path. The diagnostic names its resource.                                                                                    |
| `source-validation-failed` | A writer edit would produce invalid configuration syntax. It is not reported as a parse error in the authored file.                                                                     |
| `source-base-changed`      | The pinned tree is stale, during planning or source addition.                                                                                                                           |

## Resolve links in browser readers

Browser readers can import the same resolver from `@topik/core/wiki-navigation`
without loading compiler or filesystem modules. Query strings, fragments, hidden
targets and source-versus-route semantics follow the same contract. Resolved
fragments use their URL-encoded spelling for every href form, including same-page
`#fragment` links.

`resolveWikiContentReference` classifies an already-admitted compiled href as a
page, external URL, Asset, or unresolved reference. Readers can refuse unresolved
references without hiding failures behind the nullable `resolveWikiContentHref`
API. Local media and download paths need source-inventory classification and
compilation to Asset references first; a filename extension alone cannot prove a
download exists.

## Initialize or add a declaration

`initializeSourceProject` creates a source project where none exists. It requires:

- explicit initialization intent;
- a chosen namespace;
- a complete occupied-path inventory proving project absence;
- admitted create paths.

For a Wiki or Course, the intent's source `id` and `title` must match the
initialized resource; a different title returns `source-intent-mismatch`.

Initialization fails with `initialization-unproven` when the tree may already
hold a project. When one existing configuration file blocks it, the diagnostic
names that file in `path`; otherwise it has no `path`.

- An existing empty manifest is a project. An invalid manifest or an unresolved
  source configuration cannot be treated as absence.
- Any YAML or JSON file that parses with the strict configuration parsers and has
  string `id` and `title` values blocks initialization as a possible existing
  configuration.
- Files those parsers reject, such as JSON with comments, YAML with anchors or
  files over 1 MiB, cannot be declared as configuration and do not block.
- The conventional discovery names `wiki`, `collection` and `course` with a
  `.yaml`, `.yml` or `.json` extension are the exception: such a file blocks when
  the parsers reject it, and when it has both `id` and `title` in any form.

Unrelated files are preserved and every generated path uses no-overwrite rules.
Optional `documentPaths` assigns explicitly admitted Guide and CoursePage
filenames separately from their public slugs, including safe names for reserved
or long slug spellings. Wiki filenames follow each page's explicit navigation
`sourcePath`. A Course initializer writes its Course and module configuration
plus explicitly identified page Markdown and media.

`addSourceToProject` adds a declaration to a valid existing manifest, including
`sources: []`. It requires an intent for the source being added and
independently admitted `sources/+` root insertion evidence. The namespace,
existing declaration order and untouched source bytes are kept exactly.

Both operations generate configs, stable page IDs, Markdown and supplied media
that compile without application-specific data.

## Migrate saved source projects

`SOURCE_WRITER_DESCRIPTOR` uses reference descriptor `source-links-v5` and
provenance version `7`. Saved projects and plans made with an earlier writer do
not match, and planning and source addition refuse them with
`source-writer-incompatible`: regenerate them from authored source before writing.
See [Migrate
compiled resources and source
snapshots](./navigation.md#migrate-compiled-resources-and-source-snapshots).

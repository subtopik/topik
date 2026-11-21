import { posix } from "node:path";
import { rewriteTopikAssetOccurrences } from "@topik/content";
import type { Resource } from "../resource";
import type { Wiki } from "@topik/schema/wiki/v1";
import type { Guide } from "@topik/schema/guide/v1";
import type { Person } from "@topik/schema/person/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { Course } from "@topik/schema/course/v1";
import type { CourseModule } from "@topik/schema/course-module/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import { resolveCourseNavigation, type CourseReferenceContext } from "../course-navigation";
import {
  sourceCourseContext,
  sourceCourseModules,
  resolveSourceCourseContext,
  transportCourseReferences,
} from "./course";
import { resolveSourceReferenceContext } from "./reference-context";
import {
  normalizeSourceResourceReferences,
  resolveSourcePathReference,
} from "./resource-references";
import {
  failSourcePlan,
  sourcePlanDiagnostics,
  type SourcePlanDiagnosticCode,
} from "./diagnostics";
import {
  applySourceAssetReferenceContexts,
  type SourceAssetReferenceContexts,
} from "./asset-context";
import {
  parseTopikManifest,
  TOPIK_MANIFEST_LIMITS,
  type TopikManifestSource,
} from "../config/manifest";
import { parseWikiConfig } from "../config/wiki";
import { collectionGuideFilter, parseCollectionConfig } from "../config/collection";
import { parseCourseConfig } from "../config/course";
import { parseSafeConfigurationYaml } from "../compile/config";
import { validateResources } from "../validate";
import { serializeTopikJson, parseStrictTopikJson } from "../assets/json";
import { generateAutomaticAssetName } from "../assets/asset";
import { validateTopikPathSet } from "../assets/path";
import { resolveWikiNavigation } from "../wiki-navigation";
import {
  readSourceProject,
  digestSourceTree,
  digestSourceResourceGraph,
  snapshotSourceTree,
  SOURCE_WRITER_DESCRIPTOR,
  type SourceTreeFile,
  type SourceProject,
} from "./project";
import {
  encodeSource,
  decodeSource,
  sourceHash,
  inspectSourceSyntax,
  patchSourceSequence,
  replaySourceByteEdits,
  type SourceByteEdit,
} from "./syntax";
import {
  canonicalResource,
  type SourcePlanResult,
  type SourceFileChange,
  type SourceSharedAuthority,
  verifySharedEdits,
} from "./plan";
import {
  authoredBody,
  initialSourceDocumentPath,
  isWritableDocument,
  sourceDocumentPathCandidates,
  sourceMediaPath,
  sourcePersonRecord,
  type SourcePathCollisionPolicy,
} from "./plan-markdown";
import { sourceNavigation } from "./plan-navigation";
import { transportWikiReferences, type SourceDerivedRepair } from "./reference-transport";

export interface SourceInitializationIntent {
  namespace: string;
  source: TopikManifestSource & { id: string; title: string; assetDirectory?: string };
}
export interface SourceMediaSelection {
  name: string;
  filename: string;
  sha256: string;
  bytes: Uint8Array;
}
export interface InitializeSourceProjectInput {
  /** Full occupied-path inventory; missing/invalid manifests are never admitted as empty projects. */
  tree: readonly SourceTreeFile[];
  expectedTreeDigest: string;
  packageCohort: string;
  /** This explicit reviewed intent is sealed by the application before planning. */
  intent: SourceInitializationIntent;
  resources: readonly Resource[];
  media?: readonly SourceMediaSelection[];
  /** Immutable Wiki context retained with each saved page body. */
  referenceContexts?: Readonly<Record<string, Wiki>>;
  courseReferenceContexts?: Readonly<Record<string, CourseReferenceContext>>;
  /** Explicit new Guide or CoursePage file paths, independently admitted in createPaths. */
  documentPaths?: Readonly<Record<string, string>>;
  assetReferenceContexts?: SourceAssetReferenceContexts;
  /** Exact expected-absence paths admitted from the complete inventory. */
  createPaths: readonly string[];
  /**
   * What to do when two new Guides without an explicit document path derive the same path.
   * `"rename"` (default) appends a hash of the resource name to the later one; `"refuse"`
   * stops with `source-path-collision`, naming the path.
   */
  pathCollisions?: SourcePathCollisionPolicy;
}

/** Configuration names the standalone source compilers discover without a manifest. */
const DISCOVERED_CONFIGURATION_NAMES = new Set(
  ["wiki", "collection", "course"].flatMap((name) =>
    ["yaml", "yml", "json"].map((extension) => `${name}.${extension}`),
  ),
);

/** Initialization is distinct from adding a source to a valid existing manifest. */
export async function initializeSourceProject(
  input: InitializeSourceProjectInput,
): Promise<SourcePlanResult> {
  return buildSource(input);
}

export interface AddSourceToProjectInput {
  project: SourceProject;
  expectedTreeDigest: string;
  packageCohort: string;
  source: SourceInitializationIntent["source"];
  resources: readonly Resource[];
  media?: readonly SourceMediaSelection[];
  referenceContexts?: Readonly<Record<string, Wiki>>;
  courseReferenceContexts?: Readonly<Record<string, CourseReferenceContext>>;
  documentPaths?: Readonly<Record<string, string>>;
  assetReferenceContexts?: SourceAssetReferenceContexts;
  createPaths: readonly string[];
  manifestAuthority: SourceSharedAuthority;
  /** As {@link InitializeSourceProjectInput.pathCollisions}. */
  pathCollisions?: SourcePathCollisionPolicy;
}

/** Adding a declaration preserves the existing namespace, order and every original source. */
export async function addSourceToProject(
  input: AddSourceToProjectInput,
): Promise<SourcePlanResult> {
  try {
    if (
      serializeTopikJson(input.project.descriptor) !== serializeTopikJson(SOURCE_WRITER_DESCRIPTOR)
    )
      failure(
        "source-writer-incompatible",
        "The saved source grammar or writer has changed. Reinspect the source project before retrying.",
      );
    if (digestSourceTree(input.project.tree) !== input.expectedTreeDigest)
      failure("source-base-changed", "Source bytes no longer match the pinned tree.");
    const project = await readSourceProject({ tree: input.project.tree });
    return buildSource(
      {
        tree: project.tree,
        expectedTreeDigest: input.expectedTreeDigest,
        packageCohort: input.packageCohort,
        intent: { namespace: project.manifest.namespace, source: input.source },
        resources: input.resources,
        media: input.media,
        referenceContexts: input.referenceContexts,
        courseReferenceContexts: input.courseReferenceContexts,
        assetReferenceContexts: input.assetReferenceContexts,
        documentPaths: input.documentPaths,
        createPaths: input.createPaths,
        pathCollisions: input.pathCollisions,
      },
      { project, authority: input.manifestAuthority },
    );
  } catch (error) {
    return {
      ok: false,
      diagnostics: sourcePlanDiagnostics(error, {
        code: "source-add-validation-failed",
        message:
          "Source addition requires a valid pinned existing project and root insertion authority.",
      }),
    };
  }
}

type ExistingProject = { project: SourceProject; authority: SourceSharedAuthority };

/** Stop initialization with a declared diagnostic code. */
function failure(code: SourcePlanDiagnosticCode, message: string, path?: string): never {
  return failSourcePlan(code, message, undefined, path);
}

/** Generated files and identities shared by the steps of one {@link buildSource} call. */
interface InitializationDraft {
  readonly input: InitializeSourceProjectInput;
  readonly existing: ExistingProject | undefined;
  /** The complete pinned destination inventory. */
  readonly occupied: readonly SourceTreeFile[];
  readonly source: SourceInitializationIntent["source"];
  readonly manifest: ReturnType<typeof parseTopikManifest>;
  /** Directory of the new source configuration, or `""` at the project root. */
  readonly directory: string;
  readonly assetDirectory: string;
  /** The desired resources, cloned; media identities and content are rewritten in place. */
  readonly expected: Resource[];
  /** Markdown path of every new document. */
  readonly paths: Map<string, string>;
  readonly generatedFiles: SourceTreeFile[];
  /** Source path of every supplied medium, by its desired Asset name. */
  readonly assets: Map<string, string>;
  /** Automatic Asset identity of every supplied medium, by its desired Asset name. */
  readonly assetMappings: Map<string, string>;
  readonly derivedRepairs: SourceDerivedRepair[];
  /** Document paths and resources of the project a source is added to. */
  readonly existingPaths: ReadonlyMap<string, string>;
  readonly existingResources: ReadonlyMap<string, Resource>;
}

function addGeneratedFile(draft: InitializationDraft, path: string, raw: string | Uint8Array) {
  draft.generatedFiles.push({
    path,
    mode: "100644",
    bytes: typeof raw === "string" ? encodeSource(raw) : new Uint8Array(raw),
  });
}

/** Reject inputs that do not prove an admissible, absent destination. */
function checkInitializationInputs(
  input: InitializeSourceProjectInput,
  existing: ExistingProject | undefined,
  occupied: readonly SourceTreeFile[],
): void {
  if (!/^[a-f0-9]{64}$/.test(input.packageCohort))
    failure(
      "package-cohort-required",
      "Initialization requires the verified package cohort integrity.",
    );
  if (
    input.documentPaths &&
    Object.keys(input.documentPaths).some(
      (identity) =>
        !input.resources.some(
          (resource) =>
            (resource.type === "Guide" || resource.type === "CoursePage") &&
            identity === `${resource.type}/${resource.name}`,
        ),
    )
  )
    failure(
      "source-mapping-invalid",
      "Explicit document paths must identify new Guides or Course pages.",
    );
  if (!existing && occupied.some((file) => posix.basename(file.path) === ".topik.yaml"))
    failure(
      "initialization-unproven",
      "An existing project or resource source requires inspection and an explicit source-add decision.",
    );
  if (!existing) for (const file of occupied) checkUndeclaredConfiguration(file);
  if (
    !validateResources(input.resources).valid ||
    new Set(input.resources.map((resource) => `${resource.type}/${resource.name}`)).size !==
      input.resources.length
  )
    failure(
      "resource-invalid",
      "Initialization requires a complete valid resource graph with unique identities.",
    );
}

/**
 * A config-like file cannot be silently ignored when proving project absence.
 * Any such path may be declared as configuration, but a declared configuration
 * must pass the compiler's strict bounded parsers. A file they reject cannot be
 * one, except at a discovered configuration name, which stays unproven.
 */
function checkUndeclaredConfiguration(file: SourceTreeFile): void {
  if (!/\.(?:ya?ml|json)$/.test(file.path)) return;
  const discovered = DISCOVERED_CONFIGURATION_NAMES.has(posix.basename(file.path));
  if (!discovered && file.bytes.length > TOPIK_MANIFEST_LIMITS.maxBytes) return;
  let parsed: unknown;
  try {
    const raw = decodeSource(file.bytes);
    parsed = file.path.endsWith(".json")
      ? parseStrictTopikJson(raw.replace(/^﻿/u, ""), TOPIK_MANIFEST_LIMITS.maxDepth)
      : parseSafeConfigurationYaml(raw);
  } catch {
    if (!discovered) return;
    failure(
      "initialization-unproven",
      `Resolve the existing configuration ${file.path} before initializing a source project.`,
      file.path,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const value = parsed as Record<string, unknown>;
  // Every source configuration schema requires string `id` and `title` values; a
  // discovered configuration name stays unproven with both fields present in any form.
  if (
    discovered
      ? Object.hasOwn(value, "id") && Object.hasOwn(value, "title")
      : typeof value.id === "string" && typeof value.title === "string"
  )
    failure(
      "initialization-unproven",
      `Existing source configuration ${file.path} must be resolved before project initialization.`,
      file.path,
    );
}

/**
 * Transport a link that has no saved navigation target but names a page of the existing
 * project by its source path; relative links are re-based on the new document's directory.
 */
function transportOtherReference(
  draft: InitializationDraft,
  href: string,
  savedPath: string,
  currentPath: string,
  resource: string,
): string | undefined {
  const { existingPaths } = draft;
  const target = resolveSourcePathReference(
    href,
    savedPath,
    draft.directory,
    existingPaths,
    draft.existingResources,
  );
  if (!target) return undefined;
  if (href.startsWith("/") || posix.dirname(savedPath) === posix.dirname(currentPath)) return href;
  const url = new URL(href, "https://topik.invalid");
  const targetPath = existingPaths.get(`${target.type}/${target.name}`)!;
  const after = `${posix.relative(posix.dirname(currentPath), targetPath).split("/").map(encodeURIComponent).join("/")}${url.search}${url.hash}`;
  if (after !== href)
    draft.derivedRepairs.push({
      resource,
      kind: "reference",
      before: href,
      after,
      target: target.name,
    });
  return after;
}

/** Place every supplied medium and give its Asset the automatic identity of that path. */
function planInitialMedia(draft: InitializationDraft): void {
  const { input, expected, assets, assetMappings } = draft;
  const assetResources = expected.filter((resource) => resource.type === "Asset");
  if (assetResources.length !== (input.media?.length ?? 0))
    failure(
      "asset-bytes-required",
      "Every initialized Asset requires one exact supplied byte selection.",
    );
  for (const selection of input.media ?? []) {
    const resource = assetResources.find((asset) => asset.name === selection.name);
    if (
      !resource ||
      assetMappings.has(selection.name) ||
      sourceHash(selection.bytes) !== selection.sha256 ||
      resource.spec.integrity !== `sha256:${selection.sha256}` ||
      resource.spec.size !== selection.bytes.length
    )
      failure(
        "asset-bytes-mismatch",
        "Asset selections must match the complete desired graph and exact digests.",
      );
    const filename = posix.basename(selection.filename);
    if (filename !== selection.filename || !validateTopikPathSet([filename]).ok)
      failure("asset-path-invalid", "Media filenames must be portable leaf names.");
    const path = sourceMediaPath({
      assetDirectory: posix.join(draft.directory, draft.assetDirectory),
      filename,
      name: selection.name,
    });
    const identity = generateAutomaticAssetName({
      projectNamespace: draft.manifest.namespace,
      manifestRelativePath: path,
    });
    if (!identity.ok) failure("asset-path-invalid", "The local media destination is invalid.");
    addGeneratedFile(draft, path, selection.bytes);
    assets.set(selection.name, path);
    assetMappings.set(selection.name, identity.value);
    resource.name = identity.value;
  }
}

const personRecords = (resources: readonly Resource[]) =>
  resources
    .filter((resource): resource is Person => resource.type === "Person")
    .map(sourcePersonRecord);

/** A collection declares its Persons and places each Guide beside the configuration. */
function planCollectionSource(draft: InitializationDraft): Record<string, unknown> {
  const { input, source, directory } = draft;
  if (input.resources.some((resource) => !["Guide", "Person", "Asset"].includes(resource.type)))
    failure(
      "resource-unrepresentable",
      "A collection initializes Guides, Persons and their media only.",
    );
  // Files the new collection would read as Guides; convention files such as AGENTS.md or
  // CHANGELOG.md are left out by the compiler and may sit beside it. A README may be a Guide.
  const guides = collectionGuideFilter({});
  if (
    draft.occupied.some(
      (file) =>
        posix.dirname(file.path) === (directory || ".") &&
        guides.matches(posix.basename(file.path)),
    )
  )
    failure(
      "initialization-unproven",
      "A new collection cannot adopt existing Markdown by directory coincidence.",
    );
  const config = {
    id: source.id,
    title: source.title,
    ...(source.assetDirectory !== undefined ? { assets: { directory: draft.assetDirectory } } : {}),
    ...(input.resources.some((resource) => resource.type === "Person")
      ? { persons: personRecords(input.resources) }
      : {}),
  };
  parseCollectionConfig(config);
  const allocated = new Set<string>();
  for (const guide of input.resources.filter(
    (resource): resource is Guide => resource.type === "Guide",
  )) {
    // A collection writes `<slug>.md` whatever the slug, so the plain candidate is not used here.
    const renamed = sourceDocumentPathCandidates(directory, guide)[1];
    const explicit = input.documentPaths?.[`Guide/${guide.name}`];
    const requested =
      explicit ??
      initialSourceDocumentPath({ kind: "collection", directory, slug: guide.spec.slug });
    if (explicit === undefined && allocated.has(requested) && input.pathCollisions === "refuse")
      failSourcePlan(
        "source-path-collision",
        "Two new Guides derive the same Markdown path.",
        `Guide/${guide.name}`,
        requested,
      );
    const path = explicit === undefined && allocated.has(requested) ? renamed : requested;
    draft.paths.set(`Guide/${guide.name}`, path);
    allocated.add(path);
  }
  return config;
}

/** A Wiki places each page at its navigation source path and transports saved links. */
function planWikiSource(draft: InitializationDraft): Record<string, unknown> {
  const { input, source, directory, expected, paths } = draft;
  const wikis = expected.filter((resource): resource is Wiki => resource.type === "Wiki");
  if (
    wikis.length !== 1 ||
    wikis[0].name !== source.id ||
    input.resources.some((resource) => !["Wiki", "WikiPage", "Asset"].includes(resource.type))
  )
    failure("resource-unrepresentable", "A Wiki initializes exactly one Wiki and its pages/media.");
  const wiki = wikis[0];
  if (wiki.spec.title !== source.title)
    failure(
      "source-intent-mismatch",
      "The initialization intent title differs from the selected Wiki title.",
    );
  const originalWiki = structuredClone(wiki);
  const navigation = resolveWikiNavigation(wiki.spec.navigation ?? []);
  const pages = expected.filter((resource): resource is WikiPage => resource.type === "WikiPage");
  if (
    pages.length !== navigation.pages.length ||
    pages.some((page) => page.spec.wiki !== wiki.name || !navigation.pageByName.has(page.name))
  )
    failure(
      "source-mapping-missing",
      "Every new Wiki page needs its explicit navigation/source association.",
    );
  for (const page of navigation.pages)
    paths.set(
      `WikiPage/${page.page}`,
      initialSourceDocumentPath({ kind: "wiki", directory, sourcePath: page.sourcePath }),
    );
  const transportSources = (nodes: NonNullable<Wiki["spec"]["navigation"]>) => {
    for (const node of nodes) {
      if (node.type === "page")
        node.sourcePath = posix
          .relative(directory || ".", paths.get(`WikiPage/${node.page}`)!)
          .replace(/\.md$/, "");
      else if ("children" in node) transportSources(node.children);
    }
  };
  if (wiki.spec.navigation) transportSources(wiki.spec.navigation);
  const finalNavigation = resolveWikiNavigation(wiki.spec.navigation ?? []);
  for (const page of pages) {
    const context = resolveSourceReferenceContext(
      input.referenceContexts?.[`WikiPage/${page.name}`] ?? originalWiki,
      wiki.name,
      page.name,
    );
    if (!context.ok) failure("reference-context-invalid", context.message);
    const savedNavigation = context.navigation;
    const key = `WikiPage/${page.name}`;
    page.spec.content.value = transportWikiReferences(
      page,
      savedNavigation,
      finalNavigation,
      draft.derivedRepairs,
      {
        resolveOtherReference: (href) =>
          transportOtherReference(
            draft,
            href,
            posix.join(directory, `${savedNavigation.pageByName.get(page.name)!.sourcePath}.md`),
            paths.get(key)!,
            key,
          ),
        // The same coded diagnostics as Course initialization and source updates.
        fail: (reason) => {
          switch (reason) {
            case "unresolved":
              return failSourcePlan(
                "reference-target-unresolved",
                "An authored link has no target in its saved source context.",
                key,
              );
            case "removed":
              return failSourcePlan(
                "reference-target-removed",
                "An authored link targets a page that the new Wiki removes.",
                key,
              );
            case "unrepresentable":
              return failSourcePlan(
                "reference-unrepresentable",
                "An authored link target cannot be preserved in the new Wiki.",
                key,
              );
            case "rewrite":
              return failure(
                "source-reference-unrepresentable",
                "Initial source grammar cannot preserve a page reference.",
              );
          }
        },
      },
    ).content;
  }
  const config = {
    id: wiki.name,
    title: wiki.spec.title,
    ...(wiki.labels !== undefined ? { labels: wiki.labels } : {}),
    ...(Object.hasOwn(wiki.spec, "description") ? { description: wiki.spec.description } : {}),
    ...(wiki.spec.theme !== undefined ? { theme: wiki.spec.theme } : {}),
    ...(source.assetDirectory !== undefined ? { assets: { directory: draft.assetDirectory } } : {}),
    ...(wiki.spec.navigation !== undefined
      ? { navigation: sourceNavigation(wiki.spec.navigation, wiki, paths, directory) }
      : {}),
  };
  parseWikiConfig(config);
  return config;
}

/** A Course places each page under its module slug and transports saved links. */
function planCourseSource(draft: InitializationDraft): Record<string, unknown> {
  const { input, source, directory, expected, paths } = draft;
  const courses = expected.filter((resource): resource is Course => resource.type === "Course");
  if (
    courses.length !== 1 ||
    courses[0].name !== source.id ||
    expected.some(
      (resource) =>
        !["Course", "CourseModule", "CoursePage", "Person", "Asset"].includes(resource.type),
    )
  )
    failure(
      "resource-unrepresentable",
      "A Course initializes exactly one Course, its modules/pages, Persons and media.",
    );
  const course = courses[0];
  if (course.spec.title !== source.title)
    failure(
      "source-intent-mismatch",
      "The initialization intent title differs from the selected Course title.",
    );
  const modules = expected.filter(
    (resource): resource is CourseModule => resource.type === "CourseModule",
  );
  const pages = expected.filter(
    (resource): resource is CoursePage => resource.type === "CoursePage",
  );
  if (
    modules.some((module) => module.spec.course !== course.name) ||
    pages.some((page) => !modules.some((module) => module.name === page.spec.module))
  )
    failure(
      "source-mapping-missing",
      "Every Course module and page must belong to the selected Course.",
    );
  for (const page of pages) {
    const module = modules.find((module) => module.name === page.spec.module)!;
    paths.set(
      `CoursePage/${page.name}`,
      input.documentPaths?.[`CoursePage/${page.name}`] ??
        initialSourceDocumentPath({
          kind: "course",
          directory,
          moduleSlug: module.spec.slug,
          slug: page.spec.slug,
        }),
    );
  }
  const context = sourceCourseContext(expected, course, paths, directory);
  const current = resolveCourseNavigation(context);
  for (const page of pages) {
    const saved = resolveSourceCourseContext(
      input.courseReferenceContexts?.[`CoursePage/${page.name}`] ?? context,
      course.name,
      page.name,
    );
    transportCourseReferences(page, saved, current, draft.derivedRepairs, (href) =>
      transportOtherReference(
        draft,
        href,
        posix.join(directory, `${saved.pageByName.get(page.name)!.sourcePath}.md`),
        paths.get(`CoursePage/${page.name}`)!,
        `CoursePage/${page.name}`,
      ),
    );
  }
  const config = {
    id: course.name,
    title: course.spec.title,
    slug: course.spec.slug,
    ...(course.labels !== undefined ? { labels: course.labels } : {}),
    ...(Object.hasOwn(course.spec, "description") ? { description: course.spec.description } : {}),
    ...(course.spec.authors !== undefined ? { authors: course.spec.authors } : {}),
    ...(source.assetDirectory !== undefined ? { assets: { directory: draft.assetDirectory } } : {}),
    ...(expected.some((resource) => resource.type === "Person")
      ? { persons: personRecords(expected) }
      : {}),
    modules: sourceCourseModules(expected, course, paths, directory),
  };
  parseCourseConfig(config);
  return config;
}

/** Write every new Markdown document with complete frontmatter. */
function writeInitialDocuments(draft: InitializationDraft): void {
  for (const resource of draft.expected.filter(isWritableDocument)) {
    const path = draft.paths.get(`${resource.type}/${resource.name}`)!;
    const metadata = {
      id: resource.name,
      title: resource.spec.title,
      ...(Object.hasOwn(resource.spec, "description")
        ? { description: resource.spec.description }
        : {}),
      ...(resource.type === "CoursePage"
        ? {
            slug: resource.spec.slug,
            ...(resource.spec.authors !== undefined ? { authors: resource.spec.authors } : {}),
          }
        : {}),
      ...(resource.labels !== undefined ? { labels: resource.labels } : {}),
      ...(resource.type === "Guide"
        ? {
            slug: resource.spec.slug,
            inheritTags: false,
            ...(resource.spec.authors !== undefined ? { authors: resource.spec.authors } : {}),
            ...(resource.spec.tags !== undefined ? { tags: resource.spec.tags } : {}),
          }
        : {}),
    };
    addGeneratedFile(
      draft,
      path,
      `---\n${Object.entries(metadata)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
        .join("")}---\n${authoredBody(resource, path, draft.assets)}`,
    );
  }
}

/** Write the new manifest, or append the source to the existing one; returns its edits. */
function writeManifest(draft: InitializationDraft): SourceByteEdit[] | undefined {
  const { existing, source } = draft;
  if (!existing) {
    addGeneratedFile(
      draft,
      ".topik.yaml",
      `version: 1\nnamespace: ${JSON.stringify(draft.manifest.namespace)}\nsources:\n  - kind: ${source.kind}\n    config: ${JSON.stringify(source.config)}\n`,
    );
    return undefined;
  }
  parseTopikManifest({
    ...existing.project.manifest,
    sources: [...existing.project.manifest.sources, { kind: source.kind, config: source.config }],
  });
  const root = draft.occupied.find((file) => file.path === ".topik.yaml")!;
  const rootEdits = patchSourceSequence(
    decodeSource(root.bytes),
    "sources",
    [{ kind: source.kind, config: source.config }],
    [],
  );
  verifySharedEdits(
    root,
    existing.project.configurations.find((config) => config.path === ".topik.yaml")!,
    existing.authority,
    rootEdits,
  );
  const bytes = replaySourceByteEdits(root.bytes, rootEdits);
  // Invalid output is a writer failure, not a parse error in the existing manifest.
  try {
    inspectSourceSyntax(decodeSource(bytes));
  } catch (cause) {
    throw new TypeError("Manifest edits produced invalid syntax", { cause });
  }
  draft.generatedFiles.push({ path: root.path, mode: root.mode, bytes });
  return rootEdits;
}

/** The candidate tree: the occupied inventory (minus a replaced manifest) plus new files. */
function candidateTree(draft: InitializationDraft): SourceTreeFile[] {
  return [
    ...draft.occupied.filter((file) => !(draft.existing && file.path === ".topik.yaml")),
    ...draft.generatedFiles,
  ];
}

/** Every new path needs admitted absence and must avoid occupied and colliding paths. */
function checkGeneratedPaths(draft: InitializationDraft): void {
  const { existing, occupied, generatedFiles } = draft;
  if (
    generatedFiles.some(
      (file) =>
        !(existing && file.path === ".topik.yaml") &&
        (occupied.some((existing) => existing.path === file.path) ||
          !draft.input.createPaths.includes(file.path)),
    ) ||
    !validateTopikPathSet(candidateTree(draft).map((file) => file.path)).ok ||
    new Set(generatedFiles.map((file) => file.path)).size !== generatedFiles.length
  )
    failure(
      "initialization-collision",
      "Every new path requires admitted absence and must avoid all occupied/colliding paths.",
    );
}

/** The compiled candidate must reproduce every created document and the complete graph. */
async function verifyInitialRoundTrip(
  draft: InitializationDraft,
  candidate: SourceProject,
): Promise<void> {
  const { expected, existing } = draft;
  // Compiler remaps local media identities; supplied byte metadata must still match exactly.
  for (const resource of expected) {
    if (!isWritableDocument(resource)) continue;
    const original = candidate.compilation.resources.find(
      (other) => other.type === resource.type && other.name === resource.name,
    );
    if (!original || !isWritableDocument(original))
      failure("round-trip-mismatch", "A created document did not compile to its stable identity.");
    const normalized = {
      ...original,
      spec: { ...original.spec, content: resource.spec.content },
    } as Resource;
    if (canonicalResource(normalized) !== canonicalResource(resource))
      failure(
        "round-trip-mismatch",
        "Created source metadata does not reproduce the desired resource.",
      );
    // Replace only proven Asset identity tokens, then compare all authored content.
    const mapped = rewriteTopikAssetOccurrences(
      resource.spec.content.value,
      (occurrence) => {
        if (!occurrence.reference.startsWith("asset:")) return undefined;
        const target = draft.assetMappings.get(occurrence.reference.slice(6));
        return target ? `asset:${target}` : undefined;
      },
      { allowCompiledAssetReferences: true, includeGenericLinkCandidates: true },
    );
    if (!mapped.ok)
      failure(
        "round-trip-mismatch",
        "Asset identity mapping could not preserve authoring content.",
      );
    resource.spec.content.value = mapped.content;
  }
  if (existing) expected.push(...structuredClone(existing.project.compilation.resources));
  const compiled = new Map(
    candidate.compilation.resources.map((resource) => [
      `${resource.type}/${resource.name}`,
      resource,
    ]),
  );
  const normalizedExpected = await normalizeSourceResourceReferences(expected, candidate);
  if (
    compiled.size !== expected.length ||
    normalizedExpected.some(
      (resource) =>
        !compiled.has(`${resource.type}/${resource.name}`) ||
        canonicalResource(resource) !==
          canonicalResource(compiled.get(`${resource.type}/${resource.name}`)!),
    )
  )
    failure(
      "round-trip-mismatch",
      "The initialized source project does not reproduce the complete desired graph.",
    );
}

/** Assemble the plan and its digest over every input and output it depends on. */
function initializationPlan(
  draft: InitializationDraft,
  candidate: SourceProject,
  baseTreeDigest: string,
  rootEdits: SourceByteEdit[] | undefined,
): SourcePlanResult {
  const { input, existing, assetMappings } = draft;
  const changes: SourceFileChange[] = draft.generatedFiles
    // Bytewise like snapshotSourceTree: locale collation can vary between ICU builds.
    .sort((a, b) => Buffer.compare(encodeSource(a.path), encodeSource(b.path)))
    .map((file) => ({
      kind: existing && file.path === ".topik.yaml" ? "update" : "create",
      path: file.path,
      base:
        existing && file.path === ".topik.yaml"
          ? { sha256: existing.project.manifestSha256, mode: file.mode }
          : null,
      candidate: { mode: file.mode, sha256: sourceHash(file.bytes), bytes: file.bytes },
      ...(existing && file.path === ".topik.yaml" ? { sharedEdits: rootEdits } : {}),
    }));
  const desiredGraphDigest = digestSourceResourceGraph([
    ...(existing?.project.compilation.resources ?? []),
    ...input.resources,
  ]);
  const evidence = {
    descriptor: SOURCE_WRITER_DESCRIPTOR,
    packageCohort: input.packageCohort,
    baseTreeDigest,
    desiredGraphDigest,
    intent: input.intent,
    referenceContexts: input.referenceContexts ?? null,
    courseReferenceContexts: input.courseReferenceContexts ?? null,
    assetReferenceContexts: input.assetReferenceContexts ?? null,
    documentPaths: input.documentPaths ?? null,
    createPaths: input.createPaths,
    manifestAuthority: existing?.authority ?? null,
    media: (input.media ?? []).map((selection) => ({
      name: selection.name,
      filename: selection.filename,
      sha256: selection.sha256,
    })),
    candidateTreeDigest: candidate.treeDigest,
    assetMappings: [...assetMappings],
    changes: changes.map((change) => ({
      path: change.path,
      candidate: change.candidate!.sha256,
    })),
  };
  return {
    ok: true,
    plan: {
      descriptor: SOURCE_WRITER_DESCRIPTOR,
      packageCohort: input.packageCohort,
      baseTreeDigest,
      desiredGraphDigest,
      candidateTreeDigest: candidate.treeDigest,
      planDigest: sourceHash(encodeSource(serializeTopikJson(evidence))),
      changes,
      candidate,
      derivedRepairs: draft.derivedRepairs,
      assetMappings: [...assetMappings].map(([from, to]) => ({
        from,
        to,
        path: draft.assets.get(from)!,
      })),
      affectedResources: input.resources
        .map((resource) => `${resource.type}/${resource.name}`)
        .sort(),
    },
  };
}

async function buildSource(
  input: InitializeSourceProjectInput,
  existing?: ExistingProject,
): Promise<SourcePlanResult> {
  try {
    const occupied = snapshotSourceTree(input.tree);
    const baseTreeDigest = digestSourceTree(occupied);
    if (baseTreeDigest !== input.expectedTreeDigest)
      failure(
        "source-base-changed",
        "Initialization requires the pinned complete destination inventory.",
      );
    checkInitializationInputs(input, existing, occupied);
    const { source } = input.intent;
    const manifest = parseTopikManifest({
      version: 1,
      namespace: input.intent.namespace,
      sources: [{ kind: source.kind, config: source.config }],
    });
    const directory = posix.dirname(source.config) === "." ? "" : posix.dirname(source.config);
    const draft: InitializationDraft = {
      input,
      existing,
      occupied,
      source,
      manifest,
      directory,
      assetDirectory: source.assetDirectory ?? "_assets",
      expected: structuredClone([...input.resources]),
      paths: new Map(),
      generatedFiles: [],
      assets: new Map(),
      assetMappings: new Map(),
      derivedRepairs: [],
      existingPaths: new Map(
        existing?.project.documents.map((document) => [document.resource, document.path]) ?? [],
      ),
      existingResources: new Map(
        existing?.project.compilation.resources.map((resource) => [
          `${resource.type}/${resource.name}`,
          resource,
        ]) ?? [],
      ),
    };
    applySourceAssetReferenceContexts(
      draft.expected,
      input.assetReferenceContexts,
      draft.expected.map((resource) => `${resource.type}/${resource.name}`),
    );
    planInitialMedia(draft);
    const config =
      source.kind === "collection"
        ? planCollectionSource(draft)
        : source.kind === "wiki"
          ? planWikiSource(draft)
          : planCourseSource(draft);
    writeInitialDocuments(draft);
    addGeneratedFile(
      draft,
      source.config,
      source.config.endsWith(".json")
        ? `${JSON.stringify(config, null, 2)}\n`
        : Object.entries(config)
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
            .join(""),
    );
    const rootEdits = writeManifest(draft);
    checkGeneratedPaths(draft);
    const candidate = await readSourceProject({ tree: candidateTree(draft) });
    await verifyInitialRoundTrip(draft, candidate);
    return initializationPlan(draft, candidate, baseTreeDigest, rootEdits);
  } catch (error) {
    return {
      ok: false,
      diagnostics: sourcePlanDiagnostics(error, {
        code: "initialization-validation-failed",
        message: "Source initialization failed validation; no files may be applied.",
      }),
    };
  }
}

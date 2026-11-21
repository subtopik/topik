import { posix } from "node:path";
import {
  formatTopikContent,
  rewriteTopikAssetOccurrences,
  rewriteTopikNavigationReferences,
  parseTopikResourceReference,
  type TopikNavigationReference,
} from "@topik/content";
import type { Wiki, WikiNavNode } from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { Course } from "@topik/schema/course/v1";
import type { CourseModule } from "@topik/schema/course-module/v1";
import {
  resolveCourseContentHref,
  resolveCourseNavigation,
  type CourseReferenceContext,
} from "../course-navigation";
import {
  portableCoursePage,
  resolveSourceCourseContext,
  sourceCourseContext,
  planCourseConfiguration,
  transportCourseReferences,
} from "./course";
import { collectMetadataEdits } from "./metadata";
import { collectionGuideFilter } from "../config/collection";
import type { Resource } from "../resource";
import type { SourceMediaSelection } from "./initialize";
import { resolveSourceReferenceContext } from "./reference-context";
import { transportWikiReferences, type SourceDerivedRepair } from "./reference-transport";
import {
  normalizeSourceResourceReferences,
  prepareSourceResourceReferences,
  restoreSourceResourceReferences,
  isSourceReferenceShadowed,
} from "./resource-references";
import {
  failSourcePlan as block,
  sourcePlanDiagnostics,
  type SourcePlanDiagnostic,
} from "./diagnostics";
export type { SourcePlanDiagnostic, SourcePlanDiagnosticCode } from "./diagnostics";
import {
  applySourceAssetReferenceContexts,
  type SourceAssetReferenceContexts,
} from "./asset-context";
import {
  allocateDocumentPath,
  sourceMediaPath,
  type SourcePathCollisionPolicy,
  resourceKey,
  writeMarkdown,
  type WritableDocument,
} from "./plan-markdown";
import {
  collectNavigationEdits,
  sourceNavigation,
  type NavigationSequenceEdit,
} from "./plan-navigation";
import { validateResourceGraph, validateResources } from "../validate";
import { isSourceNonPageReference, sourcePathInventory } from "../reference-paths";
import { serializeTopikJson } from "../assets/json";
import { generateAutomaticAssetName } from "../assets/asset";
import { validateTopikPathSet } from "../assets/path";
import { resolveWikiNavigation, resolveWikiContentHref } from "../wiki-navigation";
import {
  readSourceProject,
  digestSourceTree,
  digestSourceResourceGraph,
  SOURCE_WRITER_DESCRIPTOR,
  type SourceProject,
  type SourceTreeFile,
  type SourceConfigurationProvenance,
} from "./project";
import {
  decodeSource,
  encodeSource,
  inspectSourceSyntax,
  patchSourceFields,
  patchSourceSequence,
  replaySourceByteEdits,
  sourceHash,
  type SourceFieldEvidence,
  type SourceByteEdit,
} from "./syntax";

export type SourceResourceOperation =
  | { kind: "update" | "delete"; resource: string }
  | { kind: "move"; resource: string; path: string }
  | { kind: "create"; resource: string; config: string; path?: string };
export interface SourceExclusiveAuthority {
  path: string;
  sha256: string;
  mode: SourceTreeFile["mode"];
}
export interface SourceSharedAuthority extends SourceExclusiveAuthority {
  fields: readonly SourceFieldEvidence[];
}
export interface SourceWriteAuthority {
  /** Resources whose authored or shared referenced facts may change, admitted independently. */
  resources: readonly string[];
  exclusive: readonly SourceExclusiveAuthority[];
  shared: readonly SourceSharedAuthority[];
  create: readonly string[];
}
export interface SourceFileChange {
  kind: "create" | "update" | "delete";
  path: string;
  base: { sha256: string; mode: SourceTreeFile["mode"] } | null;
  candidate: { sha256: string; mode: SourceTreeFile["mode"]; bytes: Uint8Array } | null;
  sharedEdits?: readonly SourceByteEdit[];
}
export interface SourceUpdatePlan {
  assetMappings: readonly { from: string; to: string; path: string }[];
  descriptor: typeof SOURCE_WRITER_DESCRIPTOR;
  packageCohort: string;
  baseTreeDigest: string;
  desiredGraphDigest: string;
  candidateTreeDigest: string;
  planDigest: string;
  changes: readonly SourceFileChange[];
  candidate: SourceProject;
  affectedResources: readonly string[];
  derivedRepairs: readonly {
    resource: string;
    kind: "navigation" | "reference";
    position?: string;
    before?: string;
    after?: string;
    target?: string;
  }[];
}
export type SourcePlanResult =
  | { ok: true; plan: SourceUpdatePlan }
  | { ok: false; diagnostics: readonly SourcePlanDiagnostic[] };
export interface PlanSourceUpdatesInput {
  project: SourceProject;
  expectedTreeDigest: string;
  packageCohort: string;
  /** Complete project graph, including untouched declarations and derived Assets. */
  desiredResources: readonly Resource[];
  operations: readonly SourceResourceOperation[];
  authority: SourceWriteAuthority;
  /** Retained portable context of saved authoring content, before previous source repairs. */
  referenceContexts?: Readonly<Record<string, Wiki>>;
  /** Retained Course route/source snapshots keyed by CoursePage identity. */
  courseReferenceContexts?: Readonly<Record<string, CourseReferenceContext>>;
  assetReferenceContexts?: SourceAssetReferenceContexts;
  media?: readonly (SourceMediaSelection & { config: string })[];
  /**
   * What to do when a new document has no explicit `path` and the path derived from its slug
   * is occupied. `"rename"` (default) appends a hash of the resource name, as
   * `newSourceDocumentPath` describes. `"refuse"` stops with `source-path-collision`, naming
   * the resource and the occupied path.
   */
  pathCollisions?: SourcePathCollisionPolicy;
}

function resourceMap(resources: readonly Resource[]): Map<string, Resource> {
  if (!validateResources(resources).valid)
    block(
      "resource-invalid",
      "Desired resources must satisfy the complete public resource schemas.",
    );
  const map = new Map(resources.map((resource) => [resourceKey(resource), resource]));
  if (map.size !== resources.length)
    block("identity-ambiguous", "Resource identities must be unique.");
  return map;
}
export function canonicalResource(resource: Resource): string {
  if (resource.type !== "Guide" && resource.type !== "WikiPage" && resource.type !== "CoursePage")
    return serializeTopikJson(resource);
  const content = resource.spec.content;
  if (content.format !== "topik")
    block(
      "content-unrepresentable",
      "Source writing requires unevaluated Topik authoring content.",
      resourceKey(resource),
    );
  const formatted = formatTopikContent(content.value, { allowCompiledAssetReferences: true });
  if (!formatted.ok)
    block(
      "content-unrepresentable",
      "Content cannot be written without changing its meaning.",
      resourceKey(resource),
    );
  return serializeTopikJson({
    ...resource,
    spec: { ...resource.spec, content: { ...content, value: formatted.formatted } },
  });
}
const sameResource = (a: Resource, b: Resource): boolean =>
  canonicalResource(a) === canonicalResource(b);

function hasSourceContextReferences(
  page: WritableDocument,
  isNonPageReference?: (reference: TopikNavigationReference) => boolean,
): boolean {
  let found = false;
  const inspected = rewriteTopikNavigationReferences(
    page.spec.content.value,
    (reference) => {
      if (isNonPageReference?.(reference)) return undefined;
      const { href } = reference;
      if (
        !parseTopikResourceReference(href) &&
        !/^(?:asset|https?|mailto|tel):/i.test(href) &&
        !href.startsWith("#")
      )
        found = true;
      return undefined;
    },
    { allowCompiledAssetReferences: true },
  );
  return !inspected.ok || found;
}

function sameAuthoredResource(
  a: Resource,
  b: Resource,
  base: ReadonlyMap<string, Resource>,
  contexts?: Readonly<Record<string, Wiki>>,
  courseContexts?: Readonly<Record<string, CourseReferenceContext>>,
  baseCourseContexts?: Readonly<Record<string, CourseReferenceContext>>,
  isNonPageReference?: (resource: WritableDocument, reference: TopikNavigationReference) => boolean,
): boolean {
  if (
    sameResource(a, b) &&
    (a.type !== "WikiPage" || !contexts?.[resourceKey(a)]) &&
    (a.type !== "CoursePage" || !courseContexts?.[resourceKey(a)])
  )
    return true;
  if (a.type === "CoursePage" && b.type === "CoursePage") {
    const module = base.get(`CourseModule/${a.spec.module}`);
    if (module?.type !== "CourseModule")
      block("source-mapping-missing", "The Course page has no original module.", resourceKey(a));
    const context = baseCourseContexts?.[`Course/${module.spec.course}`];
    if (!context)
      block(
        "reference-context-invalid",
        "The Course page has no original reference context.",
        resourceKey(a),
      );
    const priorNavigation = resolveSourceCourseContext(context, module.spec.course, a.name);
    const savedNavigation = resolveSourceCourseContext(
      courseContexts?.[resourceKey(b)] ?? context,
      module.spec.course,
      b.name,
    );
    return sameResource(
      portableCoursePage(
        a,
        priorNavigation,
        (reference) => isNonPageReference?.(a, reference) ?? false,
      ),
      portableCoursePage(
        b,
        savedNavigation,
        (reference) => isNonPageReference?.(b, reference) ?? false,
      ),
    );
  }
  if (a.type === "Wiki" && b.type === "Wiki") {
    const portable = (wiki: Wiki) => {
      const value = structuredClone(wiki);
      const visit = (nodes: WikiNavNode[]): void => {
        for (const node of nodes) {
          if (node.type === "page") delete node.sourcePath;
          else if ("children" in node && node.children) visit(node.children);
        }
      };
      visit(value.spec.navigation ?? []);
      return value;
    };
    return sameResource(portable(a), portable(b));
  }
  if (a.type === "WikiPage" && b.type === "WikiPage" && a.spec.wiki === b.spec.wiki) {
    const wiki = base.get(`Wiki/${a.spec.wiki}`) as Wiki;
    const portable = (page: WikiPage, context: Wiki) => {
      const navigation = resolveWikiNavigation(context.spec.navigation ?? []);
      const rewritten = rewriteTopikNavigationReferences(
        page.spec.content.value,
        (reference) => {
          if (isNonPageReference?.(page, reference)) return undefined;
          const { href } = reference;
          const target = resolveWikiContentHref(href, page.name, navigation);
          const prefix = "https://topik.invalid/reference/";
          return target
            ? `${prefix}internal/${target.page.page}${target.search}${target.hash ? `#${target.hash}` : ""}`
            : href.startsWith(prefix)
              ? `${prefix}opaque/${encodeURIComponent(href)}`
              : undefined;
        },
        { allowCompiledAssetReferences: true },
      );
      if (!rewritten.ok)
        block(
          "reference-context-invalid",
          "Saved reference meaning cannot be compared.",
          resourceKey(page),
        );
      return {
        ...page,
        spec: { ...page.spec, content: { ...page.spec.content, value: rewritten.content } },
      };
    };
    return sameResource(portable(a, wiki), portable(b, contexts?.[resourceKey(b)] ?? wiki));
  }
  return sameResource(a, b);
}

/** Shared permissions come from independent inspection/admission, never from a proposed edit. */
export function verifySharedEdits(
  file: SourceTreeFile,
  provenance: SourceConfigurationProvenance,
  authority: SourceSharedAuthority | undefined,
  edits: readonly SourceByteEdit[],
): void {
  if (!authority || authority.sha256 !== provenance.sha256 || authority.mode !== file.mode)
    block(
      "shared-authority-required",
      "Shared configuration changes require admitted authority against the exact base.",
      undefined,
      file.path,
    );
  const admitted = new Map(authority.fields.map((field) => [field.selector, field]));
  for (const field of authority.fields) {
    const original = provenance.fields.find((candidate) => candidate.selector === field.selector);
    if (!original || serializeTopikJson(original) !== serializeTopikJson(field))
      block(
        "shared-authority-stale",
        "Shared field evidence does not match source inspection.",
        undefined,
        file.path,
      );
  }
  // An admitted value also covers edits of its own items and nested fields.
  const ancestor = (selector: string) => {
    for (let end = selector.lastIndexOf("/"); end > 0; end = selector.lastIndexOf("/", end - 1)) {
      const field = admitted.get(selector.slice(0, end));
      if (field?.value) return field;
    }
    return undefined;
  };
  for (const edit of edits) {
    const fields = edit.selector.split(",").map((selector) => {
      const direct =
        admitted.get(selector) ??
        admitted.get(`${selector.slice(0, selector.lastIndexOf("/") + 1)}+`);
      if (direct) return { field: direct, inherited: false };
      const field = ancestor(selector);
      return field ? { field, inherited: true } : undefined;
    });
    if (fields.some((field) => !field))
      block(
        "shared-scope-denied",
        "A configuration edit exceeds admitted field authority.",
        undefined,
        file.path,
      );
    const resolved = fields.map((entry) => entry!);
    if (edit.start === edit.end) {
      if (
        resolved.some(({ field, inherited }) =>
          inherited
            ? edit.start < field.value!.start || edit.start > field.value!.end
            : field.insertion !== edit.start || field.value,
        )
      )
        block(
          "shared-scope-denied",
          "A configuration insertion needs its admitted empty-field anchor.",
          undefined,
          file.path,
        );
    } else {
      const ranges = resolved
        .flatMap(({ field, inherited }) =>
          (inherited ? [field.value] : [field.value, field.entry]).filter(
            (range) => range !== undefined,
          ),
        )
        .sort((a, b) => a.start - b.start);
      let covered = edit.start;
      for (const range of ranges)
        if (range.start <= covered) covered = Math.max(covered, range.end);
      if (covered < edit.end)
        block(
          "shared-scope-denied",
          "A byte edit extends outside its admitted field ranges.",
          undefined,
          file.path,
        );
    }
  }
  replaySourceByteEdits(file.bytes, edits);
}

/** At a shared block boundary, nested insertions belong before enclosing siblings. */
function compareSharedEdits(left: SourceByteEdit, right: SourceByteEdit): number {
  const position = left.start - right.start || left.end - right.end;
  if (position || left.start !== left.end || right.start !== right.end) return position;
  const depth = (edit: SourceByteEdit) =>
    Math.max(...edit.selector.split(",").map((selector) => selector.split("/").length));
  return depth(right) - depth(left);
}

type SourceDocument = SourceProject["documents"][number];
type PlannedMedium = {
  selection: SourceMediaSelection & { config: string };
  asset: Extract<Resource, { type: "Asset" }>;
  path: string;
  name: string;
};

/** Mutable planning state shared by the steps of one {@link planSourceUpdates} call. */
interface PlanState {
  readonly input: PlanSourceUpdatesInput;
  /** The pinned base project, reinspected from its tree. */
  readonly project: SourceProject;
  readonly base: ReadonlyMap<string, Resource>;
  /** The desired graph; replaced as a whole when media identities are remapped. */
  desired: Map<string, Resource>;
  readonly operationKeys: ReadonlySet<string>;
  /** Resources changed by a derived repair rather than an explicit operation. */
  readonly derivedKeys: Set<string>;
  readonly derivedRepairs: SourceDerivedRepair[];
  readonly files: ReadonlyMap<string, SourceTreeFile>;
  /** Current document path of every resource, including planned creates and moves. */
  readonly paths: Map<string, string>;
  /** Document paths in the base project. */
  readonly originalPaths: ReadonlyMap<string, string>;
  /** Every occupied or planned path. */
  readonly reserved: Set<string>;
  /** File modes of documents that move to a new path. */
  readonly createdModes: Map<string, SourceTreeFile["mode"]>;
  /** Parsed values of every declared source configuration, inspected after path allocation. */
  configs: ReadonlyMap<string, Record<string, unknown>>;
  readonly configUpdates: Map<string, Record<string, unknown>>;
  readonly navigationUpdates: Map<string, { previous: Wiki; desired: Wiki; directory: string }>;
  readonly personAdditions: Map<string, unknown[]>;
  readonly personDeletions: Map<string, string[]>;
  readonly courseSequenceEdits: Map<string, SourceByteEdit[]>;
  /** Proven source path of every Asset name. */
  readonly assets: Map<string, string>;
  readonly modified: Map<string, Uint8Array>;
  readonly deleted: Set<string>;
}

/** Path inventories and saved-reference provenance used by reference repair. */
interface ReferenceScope {
  readonly originalInventory: ReadonlySet<string>;
  readonly currentInventory: ReadonlySet<string>;
  /** Base documents, with references prepared from freshly supplied source paths. */
  readonly referenceDocuments: Map<string, SourceDocument | undefined>;
  /** Resources whose resource references were restored to source spelling. */
  readonly referenceRepairKeys: Set<string>;
  sourceDirectory(key: string): string;
  /** Whether a reference names a file or folder rather than a page. */
  nonPageReference(
    resource: WritableDocument,
    reference: TopikNavigationReference,
    hasSavedTarget: boolean,
  ): boolean;
}

const isWritableDocument = (resource: Resource): resource is WritableDocument =>
  resource.type === "Guide" || resource.type === "WikiPage" || resource.type === "CoursePage";
const documentOf = (project: SourceProject, key: string): SourceDocument | undefined =>
  project.documents.find((document) => document.resource === key);
const provenanceOf = (project: SourceProject, config: string | undefined) =>
  project.compilation.provenance.find((source) => source.config === config);

/** Reject a plan whose cohort, writer or pinned base tree does not match. */
function checkPlanPins(input: PlanSourceUpdatesInput): void {
  if (!/^[a-f0-9]{64}$/.test(input.packageCohort))
    block("package-cohort-required", "Plans require the verified package cohort integrity.");
  if (serializeTopikJson(input.project.descriptor) !== serializeTopikJson(SOURCE_WRITER_DESCRIPTOR))
    block(
      "source-writer-incompatible",
      "The saved source grammar or writer has changed. Reinspect the source project before retrying.",
    );
  if (
    digestSourceTree(input.project.tree) !== input.expectedTreeDigest ||
    input.project.treeDigest !== input.expectedTreeDigest
  )
    block("source-base-changed", "Source bytes no longer match the pinned tree.");
}

/** Each operation is admitted, unique and consistent with the base and desired graphs. */
function checkOperations(
  input: PlanSourceUpdatesInput,
  base: ReadonlyMap<string, Resource>,
  desired: ReadonlyMap<string, Resource>,
): Set<string> {
  const operationKeys = new Set<string>();
  for (const op of input.operations) {
    if (!input.authority.resources.includes(op.resource))
      block(
        "resource-scope-denied",
        "The operation exceeds the admitted resource scope.",
        op.resource,
      );
    if (operationKeys.has(op.resource))
      block("operation-ambiguous", "Each resource requires one explicit operation.", op.resource);
    operationKeys.add(op.resource);
    if (
      op.kind === "create"
        ? base.has(op.resource) || !desired.has(op.resource)
        : !base.has(op.resource) ||
          (op.kind === "delete" ? desired.has(op.resource) : !desired.has(op.resource))
    )
      block(
        "operation-inconsistent",
        "Operations must match the complete base and desired graphs.",
        op.resource,
      );
  }
  return operationKeys;
}

/** Every authored difference between the graphs needs an explicit operation. */
function requireExplicitIntent(
  input: PlanSourceUpdatesInput,
  project: SourceProject,
  base: ReadonlyMap<string, Resource>,
  desired: ReadonlyMap<string, Resource>,
  operationKeys: ReadonlySet<string>,
): void {
  const originalInventory = sourcePathInventory(project.tree.map((file) => file.path));
  const originalDocumentsByKey = new Map(
    project.documents.map((document) => [document.resource, document]),
  );
  const originalNonPageReference = (
    resource: WritableDocument,
    reference: TopikNavigationReference,
  ) => {
    const document = originalDocumentsByKey.get(resourceKey(resource));
    return document
      ? isSourceNonPageReference(reference, document.path, document.directory, originalInventory)
      : false;
  };
  for (const [key, resource] of base) {
    if (resource.type === "Asset") continue;
    const next = desired.get(key);
    if (
      !operationKeys.has(key) &&
      (!next ||
        !sameAuthoredResource(
          resource,
          next,
          base,
          input.referenceContexts,
          input.courseReferenceContexts,
          project.courseContexts,
          originalNonPageReference,
        ))
    )
      block("operation-required", "Every changed or deleted resource needs explicit intent.", key);
  }
  for (const [key, resource] of desired)
    if (resource.type !== "Asset" && !base.has(key) && !operationKeys.has(key))
      block("operation-required", "Every created resource needs explicit intent.", key);
}

/** Reserve the Markdown path of every created or moved document. */
function allocateOperationPaths(state: PlanState): void {
  const { input, project, desired, paths, reserved } = state;
  for (const op of input.operations) {
    if (op.kind !== "create" && op.kind !== "move") continue;
    const next = desired.get(op.resource)!;
    if (!isWritableDocument(next)) continue;
    const config = op.kind === "create" ? op.config : documentOf(project, op.resource)!.config;
    const source = provenanceOf(project, config);
    if (!source)
      block("source-mapping-missing", "The operation needs its declared source.", op.resource);
    // The requested path is caller text: name only the resource, never echo the path.
    if (op.path !== undefined && !validateTopikPathSet([op.path]).ok)
      block(
        "source-path-invalid",
        "The requested source path is not a portable project path.",
        op.resource,
      );
    const path =
      op.path ??
      allocateDocumentPath(
        {
          ...project,
          tree: [...reserved].map((path) => ({ path, mode: "100644", bytes: new Uint8Array() })),
        },
        source.directory,
        next,
        input.pathCollisions,
      );
    if (reserved.has(path))
      block(
        "source-path-collision",
        "New paths cannot overwrite occupied paths.",
        op.resource,
        path,
      );
    reserved.add(path);
    paths.set(op.resource, path);
    if (op.kind === "move") state.createdModes.set(path, documentOf(project, op.resource)!.mode);
  }
}

/**
 * Plan every media destination before reference repair so its parent directories
 * participate in the same candidate inventory as document creates and moves.
 */
function planMediaDestinations(state: PlanState): PlannedMedium[] {
  const { project, desired, reserved } = state;
  const mediaNames = new Set<string>();
  return (state.input.media ?? []).map((selection) => {
    const asset = desired.get(`Asset/${selection.name}`);
    const source = provenanceOf(project, selection.config);
    if (
      asset?.type !== "Asset" ||
      !source ||
      mediaNames.has(selection.name) ||
      sourceHash(selection.bytes) !== selection.sha256 ||
      asset.spec.integrity !== `sha256:${selection.sha256}` ||
      asset.spec.size !== selection.bytes.length
    )
      block(
        "asset-bytes-mismatch",
        "Every new medium requires an exact desired Asset, declared destination and supplied bytes.",
      );
    if (
      posix.basename(selection.filename) !== selection.filename ||
      !validateTopikPathSet([selection.filename]).ok
    )
      block("asset-path-invalid", "Media filenames must be portable leaf names.");
    const path = sourceMediaPath({
      assetDirectory: source.assetDirectory,
      filename: selection.filename,
      name: selection.name,
    });
    if (reserved.has(path) || !validateTopikPathSet([...reserved, path]).ok)
      block(
        "source-path-collision",
        "New media cannot overwrite any occupied path.",
        undefined,
        path,
      );
    const identity = generateAutomaticAssetName({
      projectNamespace: project.manifest.namespace,
      manifestRelativePath: path,
    });
    if (!identity.ok) block("asset-path-invalid", "The new media destination is invalid.");
    mediaNames.add(selection.name);
    reserved.add(path);
    return { selection, asset, path, name: identity.value };
  });
}

/** Inventories and the non-page reference rule shared by every reference repair step. */
function createReferenceScope(
  state: PlanState,
  plannedMedia: readonly PlannedMedium[],
): ReferenceScope {
  const { input, project, paths, desired } = state;
  const originalInventory = sourcePathInventory(project.tree.map((file) => file.path));
  const originalDocumentsByKey = new Map(
    project.documents.map((document) => [document.resource, document]),
  );
  const originalDocuments = new Set(state.originalPaths.values());
  const currentInventory = sourcePathInventory([
    ...project.tree.map((file) => file.path).filter((path) => !originalDocuments.has(path)),
    ...[...paths].filter(([key]) => desired.has(key)).map(([, path]) => path),
    ...plannedMedia.map(({ path }) => path),
  ]);
  const sourceDirectory = (key: string) => {
    const document = originalDocumentsByKey.get(key);
    if (document) return document.directory;
    const creation = input.operations.find(
      (operation): operation is Extract<SourceResourceOperation, { kind: "create" }> =>
        operation.resource === key && operation.kind === "create",
    );
    return provenanceOf(project, creation?.config)?.directory ?? "";
  };
  return {
    originalInventory,
    currentInventory,
    referenceDocuments: new Map(project.documents.map((document) => [document.resource, document])),
    referenceRepairKeys: new Set(),
    sourceDirectory,
    nonPageReference(resource, reference, hasSavedTarget) {
      const key = resourceKey(resource);
      const document = originalDocumentsByKey.get(key);
      const path = document?.path ?? paths.get(key);
      if (!path) return false;
      const directory = sourceDirectory(key);
      if (isSourceNonPageReference(reference, path, directory, originalInventory)) return true;
      if (hasSavedTarget) return false;
      return isSourceNonPageReference(reference, path, directory, currentInventory);
    },
  };
}

/** Interpret freshly supplied source paths before the scope-local Wiki and Course passes. */
function prepareReferenceDocuments(state: PlanState, scope: ReferenceScope): void {
  for (const [key, resource] of state.desired) {
    if (!isWritableDocument(resource)) continue;
    const path = state.paths.get(key);
    if (!path) continue;
    const prepared = prepareSourceResourceReferences(
      resource,
      scope.referenceDocuments.get(key),
      path,
      scope.sourceDirectory(key),
      state.originalPaths,
      state.paths,
      state.base,
      state.desired,
      scope.originalInventory,
      scope.currentInventory,
    );
    if (prepared) scope.referenceDocuments.set(key, prepared);
  }
}

/** Course membership edits and saved-to-current reference transport for each Course. */
function planCourseRepairs(state: PlanState, scope: ReferenceScope): void {
  const { input, project, base, desired, paths } = state;
  for (const course of desired.values()) {
    if (course.type !== "Course") continue;
    const document = documentOf(project, resourceKey(course));
    const previous = base.get(resourceKey(course));
    if (!document || previous?.type !== "Course")
      block(
        "source-creation-required",
        "Course creation needs explicit source initialization.",
        resourceKey(course),
      );
    const config = document.config;
    const source = provenanceOf(project, config)!;
    const configuration = planCourseConfiguration({
      before: [...base.values()],
      desired: [...desired.values()],
      course,
      originalCourse: previous,
      paths,
      originalPaths: state.originalPaths,
      directory: source.directory,
      raw: decodeSource(state.files.get(config)!.bytes),
      json: config.endsWith(".json"),
    });
    for (const key of configuration.membershipResources) state.derivedKeys.add(key);
    state.configUpdates.set(config, {
      ...state.configUpdates.get(config),
      ...configuration.updates,
    });
    if (configuration.edits.length) state.courseSequenceEdits.set(config, configuration.edits);
    const currentContext = sourceCourseContext(
      [...desired.values()],
      course,
      paths,
      source.directory,
    );
    const currentNavigation = resolveCourseNavigation(currentContext);
    const previousContext = project.courseContexts[resourceKey(course)];
    for (const page of desired.values()) {
      if (page.type !== "CoursePage" || !currentNavigation.pageByName.has(page.name)) continue;
      const key = resourceKey(page);
      const prior = base.get(key);
      const context =
        input.courseReferenceContexts?.[key] ??
        (prior?.type === "CoursePage" ? previousContext : currentContext);
      const saved = resolveSourceCourseContext(context, course.name, page.name);
      const isNonPageReference = (reference: TopikNavigationReference) =>
        scope.nonPageReference(
          page,
          reference,
          resolveCourseContentHref(reference.href, page.name, saved) !== null,
        );
      if (
        !input.courseReferenceContexts?.[key] &&
        hasSourceContextReferences(page, isNonPageReference) &&
        prior?.type === "CoursePage" &&
        canonicalResource(prior) !==
          canonicalResource({ ...prior, spec: { ...prior.spec, content: page.spec.content } }) &&
        serializeTopikJson(previousContext) !== serializeTopikJson(currentContext)
      )
        block(
          "reference-context-required",
          "Changed Course authoring content needs its retained context when routes or source paths change.",
          key,
        );
      if (
        transportCourseReferences(
          page,
          saved,
          currentNavigation,
          state.derivedRepairs,
          undefined,
          isNonPageReference,
          (reference, current) =>
            isSourceReferenceShadowed(
              page,
              reference,
              paths.get(key)!,
              source.directory,
              paths,
              desired,
              scope.currentInventory,
              `CoursePage/${current?.page.page}`,
            ),
        )
      )
        state.derivedKeys.add(key);
    }
  }
}

/** Wiki navigation source paths and saved-to-current reference transport for each Wiki. */
function planWikiRepairs(state: PlanState, scope: ReferenceScope): void {
  const { input, project, base, desired, paths } = state;
  for (const resource of desired.values()) {
    if (resource.type !== "Wiki") continue;
    const document = documentOf(project, resourceKey(resource));
    const previous = base.get(resourceKey(resource));
    if (!document || previous?.type !== "Wiki")
      block(
        "source-creation-required",
        "Wiki creation needs explicit declaration initialization.",
        resourceKey(resource),
      );
    const config = document.config;
    const source = provenanceOf(project, config)!;
    const visit = (nodes: WikiNavNode[]): void => {
      for (const node of nodes) {
        if (node.type === "page") {
          const path = paths.get(`WikiPage/${node.page}`);
          if (!path)
            block(
              "source-mapping-missing",
              "Every navigation page needs a proven source.",
              resourceKey(resource),
            );
          node.sourcePath = posix.relative(source.directory || ".", path).replace(/\.mdx?$/i, "");
        } else if ("children" in node && node.children) visit(node.children);
      }
    };
    visit(resource.spec.navigation ?? []);
    if (!sameResource(previous, resource)) {
      state.derivedKeys.add(resourceKey(resource));
      if (!state.operationKeys.has(resourceKey(resource)))
        state.derivedRepairs.push({ resource: resourceKey(resource), kind: "navigation" });
    }
    const currentNavigation = resolveWikiNavigation(resource.spec.navigation ?? []);
    for (const page of desired.values()) {
      if (page.type !== "WikiPage" || page.spec.wiki !== resource.name) continue;
      const key = resourceKey(page);
      const priorPage = base.get(key);
      const context = resolveSourceReferenceContext(
        input.referenceContexts?.[key] ?? previous,
        resource.name,
        page.name,
      );
      if (!context.ok) block("reference-context-invalid", context.message, key);
      const savedNavigation = context.navigation;
      const isNonPageReference = (reference: TopikNavigationReference) =>
        scope.nonPageReference(
          page,
          reference,
          resolveWikiContentHref(reference.href, page.name, savedNavigation) !== null,
        );
      if (
        !input.referenceContexts?.[key] &&
        hasSourceContextReferences(page, isNonPageReference) &&
        priorPage?.type === "WikiPage" &&
        canonicalResource(priorPage) !==
          canonicalResource({
            ...priorPage,
            spec: { ...priorPage.spec, content: page.spec.content },
          }) &&
        serializeTopikJson(previous.spec.navigation ?? null) !==
          serializeTopikJson(resource.spec.navigation ?? null)
      )
        block(
          "reference-context-required",
          "Changed authoring content needs its retained context when Wiki routes or source grammar change.",
          key,
        );
      const transported = transportWikiReferences(
        page,
        savedNavigation,
        currentNavigation,
        state.derivedRepairs,
        {
          isNonPageReference,
          isCurrentShadowed: (reference, after) =>
            isSourceReferenceShadowed(
              page,
              reference,
              paths.get(key)!,
              source.directory,
              paths,
              desired,
              scope.currentInventory,
              `WikiPage/${after?.page.page}`,
            ),
          fail: (failure) => {
            switch (failure) {
              case "unresolved":
                return block(
                  "reference-target-unresolved",
                  "An authored link has no target in its saved source context.",
                  key,
                );
              case "removed":
                return block(
                  "reference-target-removed",
                  "An authored reference still targets a removed page.",
                  key,
                );
              case "unrepresentable":
                return block(
                  "reference-unrepresentable",
                  "A source reference cannot preserve its target.",
                  key,
                );
              case "rewrite":
                return block(
                  "reference-unrepresentable",
                  "Authoring references cannot be rewritten faithfully.",
                  key,
                );
            }
          },
        },
      );
      if (transported.changed) {
        page.spec.content.value = transported.content;
        state.derivedKeys.add(key);
      }
    }
  }
}

/** Restore cross-source resource references to their source spelling. */
function restoreReferenceRepairs(state: PlanState, scope: ReferenceScope): void {
  for (const [key, resource] of state.desired) {
    if (!isWritableDocument(resource)) continue;
    const path = state.paths.get(key);
    if (!path) continue;
    const restored = restoreSourceResourceReferences(
      resource,
      scope.referenceDocuments.get(key),
      path,
      state.paths,
      state.originalPaths,
      state.base,
      state.desired,
      scope.currentInventory,
    );
    if (restored.repairs.length) {
      state.derivedRepairs.push(...restored.repairs);
      state.derivedKeys.add(key);
      scope.referenceRepairKeys.add(key);
    }
  }
}

/** Explicit operations plus an update for every derived repair, all inside admitted scope. */
function effectiveOperations(state: PlanState): SourceResourceOperation[] {
  const operations = [
    ...state.input.operations,
    ...[...state.derivedKeys]
      .filter((key) => !state.operationKeys.has(key))
      .map((resource) => ({ kind: "update" as const, resource })),
  ];
  for (const op of operations)
    if (!state.input.authority.resources.includes(op.resource))
      block(
        "resource-scope-denied",
        "A derived repair exceeds admitted resource scope.",
        op.resource,
      );
  return operations;
}

/** Map every planned medium to its automatic Asset identity and write its bytes. */
function applyPlannedMedia(
  state: PlanState,
  plannedMedia: readonly PlannedMedium[],
): SourceUpdatePlan["assetMappings"][number][] {
  const { project, assets } = state;
  for (const file of project.tree) {
    const generated = generateAutomaticAssetName({
      projectNamespace: project.manifest.namespace,
      manifestRelativePath: file.path,
    });
    if (generated.ok) assets.set(generated.value, file.path);
  }
  const assetMappings: SourceUpdatePlan["assetMappings"][number][] = [];
  for (const { selection, asset, path, name } of plannedMedia) {
    assetMappings.push({ from: selection.name, to: name, path });
    asset.name = name;
    assets.set(name, path);
    state.modified.set(path, new Uint8Array(selection.bytes));
  }
  if (!assetMappings.length) return assetMappings;
  for (const resource of state.desired.values()) {
    if (!isWritableDocument(resource)) continue;
    const rewritten = rewriteTopikAssetOccurrences(
      resource.spec.content.value,
      (occurrence) => {
        const mapping = assetMappings.find(
          (mapping) => occurrence.reference === `asset:${mapping.from}`,
        );
        return mapping ? `asset:${mapping.to}` : undefined;
      },
      { allowCompiledAssetReferences: true, includeGenericLinkCandidates: true },
    );
    if (!rewritten.ok)
      block(
        "asset-reference-unrepresentable",
        "New media references cannot be written faithfully.",
        resourceKey(resource),
      );
    resource.spec.content.value = rewritten.content;
  }
  state.desired = resourceMap([...state.desired.values()]);
  return assetMappings;
}

/** Plan the source edits of one effective operation. */
function planOperation(state: PlanState, scope: ReferenceScope, op: SourceResourceOperation): void {
  const next = state.desired.get(op.resource);
  const previous = state.base.get(op.resource);
  if (
    next &&
    previous &&
    sameResource(previous, next) &&
    op.kind === "update" &&
    !scope.referenceRepairKeys.has(op.resource)
  )
    return;
  if ((next ?? previous)?.type === "Person") return planPersonOperation(state, op, previous, next);
  if (op.kind === "delete") return planDeletion(state, op, previous!);
  if (!next)
    block(
      "operation-inconsistent",
      "An update requires its complete desired resource.",
      op.resource,
    );
  if (next.type === "Wiki") return planWikiOperation(state, op, previous, next);
  if (next.type === "Course") return planCourseOperation(state, op, previous, next);
  if (next.type === "CourseModule") return planCourseModuleOperation(state, op, previous, next);
  if (!isWritableDocument(next))
    block(
      "resource-unrepresentable",
      "This resource operation has no admitted source representation.",
      op.resource,
    );
  planDocumentOperation(state, scope, op, previous, next);
}

/** Persons are records in their collection or Course configuration. */
function planPersonOperation(
  state: PlanState,
  op: SourceResourceOperation,
  previous: Resource | undefined,
  next: Resource | undefined,
): void {
  const { input, project } = state;
  const name = (next ?? previous)!.name;
  for (const authoringResource of [...state.base.values(), ...state.desired.values()]) {
    if (
      (authoringResource.type !== "Guide" &&
        authoringResource.type !== "Course" &&
        authoringResource.type !== "CoursePage") ||
      !authoringResource.spec.authors?.includes(name)
    )
      continue;
    const key = resourceKey(authoringResource);
    if (!input.authority.resources.includes(key))
      block(
        "shared-reference-scope-denied",
        "A shared Person change affects an authoring resource outside admitted resource scope.",
        key,
      );
    state.derivedKeys.add(key);
  }
  if (op.kind === "move")
    block(
      "resource-unrepresentable",
      "Persons stay inside their declared collection configuration.",
      op.resource,
    );
  const document = documentOf(project, op.resource);
  const config = op.kind === "create" ? op.config : document?.config;
  const source = provenanceOf(project, config);
  if (!config || (source?.kind !== "collection" && source?.kind !== "course"))
    block(
      "source-mapping-missing",
      "A Person needs its exact declared collection or Course source.",
      op.resource,
    );
  const updates = state.configUpdates.get(config) ?? {};
  const selector = `persons/${encodeURIComponent(op.resource.slice(7))}`;
  if (op.kind === "delete")
    state.personDeletions.set(config, [...(state.personDeletions.get(config) ?? []), selector]);
  else if (op.kind === "create") {
    const person = next!;
    state.personAdditions.set(config, [
      ...(state.personAdditions.get(config) ?? []),
      {
        id: person.name,
        ...(person.labels !== undefined ? { labels: person.labels } : {}),
        spec: person.spec,
      },
    ]);
  } else {
    collectMetadataEdits(updates, `${selector}/labels`, previous!.labels, next!.labels);
    collectMetadataEdits(updates, `${selector}/spec`, previous!.spec, next!.spec);
  }
  state.configUpdates.set(config, updates);
}

/** Only empty Course modules and exclusive Markdown documents can be deleted. */
function planDeletion(state: PlanState, op: SourceResourceOperation, previous: Resource): void {
  if (previous.type === "CourseModule") {
    if (
      [...state.desired.values()].some(
        (resource) => resource.type === "CoursePage" && resource.spec.module === previous.name,
      )
    )
      block(
        "module-not-empty",
        "Delete or reassign every Course page before deleting its module.",
        op.resource,
      );
    return;
  }
  if (!isWritableDocument(previous))
    block(
      "source-deletion-required",
      "Shared sources require explicit source-level deletion authority.",
      op.resource,
    );
  state.deleted.add(state.paths.get(op.resource)!);
}

/** Wiki metadata edits its declaration; navigation changes are aligned later. */
function planWikiOperation(
  state: PlanState,
  op: SourceResourceOperation,
  previous: Resource | undefined,
  next: Wiki,
): void {
  const document = documentOf(state.project, op.resource);
  if (!document || op.kind !== "update" || previous?.type !== "Wiki")
    block(
      "source-creation-required",
      "Wiki creation needs explicit declaration initialization.",
      op.resource,
    );
  const old = previous;
  const updates = state.configUpdates.get(document.config) ?? {};
  for (const field of ["title", "description"] as const)
    if (
      serializeTopikJson(old.spec[field] ?? null) !==
        serializeTopikJson(next.spec[field] ?? null) ||
      Object.hasOwn(old.spec, field) !== Object.hasOwn(next.spec, field)
    )
      updates[field] = next.spec[field];
  collectMetadataEdits(updates, "theme", old.spec.theme, next.spec.theme);
  collectMetadataEdits(updates, "labels", old.labels, next.labels);
  if (
    serializeTopikJson(old.spec.navigation ?? null) !==
    serializeTopikJson(next.spec.navigation ?? null)
  ) {
    if (next.spec.navigation === undefined) updates.navigation = undefined;
    else
      state.navigationUpdates.set(document.config, {
        previous: old,
        desired: next,
        directory: document.directory,
      });
  }
  state.configUpdates.set(document.config, updates);
}

/** Course metadata edits its declaration. */
function planCourseOperation(
  state: PlanState,
  op: SourceResourceOperation,
  previous: Resource | undefined,
  next: Course,
): void {
  const document = documentOf(state.project, op.resource);
  if (!document || op.kind !== "update" || previous?.type !== "Course")
    block(
      "source-creation-required",
      "Courses remain in their explicitly initialized source configuration.",
      op.resource,
    );
  const updates = state.configUpdates.get(document.config) ?? {};
  for (const field of ["title", "slug", "description", "authors"] as const)
    collectMetadataEdits(updates, field, previous.spec[field], next.spec[field]);
  collectMetadataEdits(updates, "labels", previous.labels, next.labels);
  state.configUpdates.set(document.config, updates);
}

/** Module records were planned with their Course; only their source placement is checked. */
function planCourseModuleOperation(
  state: PlanState,
  op: SourceResourceOperation,
  previous: Resource | undefined,
  next: CourseModule,
): void {
  const { project } = state;
  const config = op.kind === "create" ? op.config : documentOf(project, op.resource)?.config;
  const source = provenanceOf(project, config);
  const course = state.desired.get(`Course/${next.spec.course}`);
  if (
    !config ||
    source?.kind !== "course" ||
    course?.type !== "Course" ||
    documentOf(project, resourceKey(course))?.config !== config ||
    op.kind === "move" ||
    (previous?.type === "CourseModule" && previous.spec.course !== next.spec.course)
  )
    block(
      "source-mapping-missing",
      "Course modules must stay inside their declared Course source.",
      op.resource,
    );
}

/** Whether compilation would read `path` as a guide of the collection declared by `config`. */
function isCollectionGuidePath(
  state: PlanState,
  config: string,
  directory: string,
  path: string,
): boolean {
  if (directory && !path.startsWith(`${directory}/`)) return false;
  const values = state.configs.get(config) ?? {};
  return collectionGuideFilter({
    include: values.include as string[] | undefined,
    exclude: values.exclude as string[] | undefined,
  }).matches(directory ? path.slice(directory.length + 1) : path);
}

/** Write a Guide, Wiki page or Course page to its Markdown document. */
function planDocumentOperation(
  state: PlanState,
  scope: ReferenceScope,
  op: SourceResourceOperation,
  previous: Resource | undefined,
  next: WritableDocument,
): void {
  const { project, files, paths } = state;
  const document = documentOf(project, op.resource);
  const config = op.kind === "create" ? op.config : document!.config;
  const source = provenanceOf(project, config);
  if (
    !source ||
    (next.type === "Guide"
      ? source.kind !== "collection"
      : next.type === "WikiPage"
        ? source.kind !== "wiki"
        : source.kind !== "course")
  )
    block(
      "source-mapping-missing",
      "The operation must use its exact declared source.",
      op.resource,
    );
  const path = paths.get(op.resource) ?? document!.path;
  if (next.type === "Guide" && !isCollectionGuidePath(state, config!, source.directory, path))
    block(
      "source-path-invalid",
      "Guides must be files their declared collection configuration reads.",
      op.resource,
    );
  if (
    (next.type === "WikiPage" || next.type === "CoursePage") &&
    source.directory &&
    !path.startsWith(`${source.directory}/`)
  )
    block(
      "source-path-invalid",
      "Pages must remain inside their declared content root.",
      op.resource,
    );
  if (!/\.mdx?$/.test(path))
    block("source-path-invalid", "Source pages require a Markdown extension.", op.resource);
  if ((op.kind === "create" || op.kind === "move") && files.has(path))
    block(
      "source-path-collision",
      "A new source path may not overwrite an existing file.",
      op.resource,
      path,
    );
  paths.set(op.resource, path);
  if (next.type === "CoursePage") {
    const module = state.desired.get(`CourseModule/${next.spec.module}`);
    const course =
      module?.type === "CourseModule"
        ? state.desired.get(`Course/${module.spec.course}`)
        : undefined;
    if (course?.type !== "Course" || documentOf(project, resourceKey(course))?.config !== config)
      block(
        "source-mapping-missing",
        "A Course page must belong to a module in its declared source.",
        op.resource,
      );
  }
  state.modified.set(
    path,
    writeMarkdown(
      document ? files.get(document.path) : undefined,
      previous as WritableDocument | undefined,
      next,
      op.kind === "move",
      path,
      state.assets,
      restoreSourceResourceReferences(
        next,
        scope.referenceDocuments.get(op.resource),
        path,
        paths,
        state.originalPaths,
        state.base,
        state.desired,
        scope.currentInventory,
      ).content,
      scope.referenceRepairKeys.has(op.resource),
    ),
  );
  if (op.kind === "move") state.deleted.add(document!.path);
}

/** Align each changed Wiki navigation with its source items. */
function planNavigationSequences(
  state: PlanState,
): Map<string, Map<string, NavigationSequenceEdit>> {
  const navigationSequences = new Map<string, Map<string, NavigationSequenceEdit>>();
  for (const [config, { previous, desired: wiki, directory }] of state.navigationUpdates) {
    const updates = state.configUpdates.get(config)!;
    const sequences = new Map<string, NavigationSequenceEdit>();
    navigationSequences.set(config, sequences);
    collectNavigationEdits(
      updates,
      sequences,
      "navigation",
      state.configs.get(config)!.navigation,
      sourceNavigation(previous.spec.navigation ?? [], previous, state.originalPaths, directory),
      sourceNavigation(wiki.spec.navigation ?? [], wiki, state.paths, directory),
    );
  }
  return navigationSequences;
}

/** Combine and verify every shared configuration edit, then write the edited files. */
function planSharedConfigurationEdits(
  state: PlanState,
  navigationSequences: ReadonlyMap<string, ReadonlyMap<string, NavigationSequenceEdit>>,
): Map<string, readonly SourceByteEdit[]> {
  const { configs } = state;
  const sharedEdits = new Map<string, readonly SourceByteEdit[]>();
  for (const [path, updates] of state.configUpdates) {
    const file = state.files.get(path)!;
    const additions = state.personAdditions.get(path) ?? [];
    const removals = state.personDeletions.get(path) ?? [];
    if (additions.length && configs.get(path)!.persons === undefined) updates.persons = additions;
    const patch = patchSourceFields(decodeSource(file.bytes), updates, path.endsWith(".json"));
    const edits = [
      ...(state.courseSequenceEdits.get(path) ?? []),
      ...patch.edits,
      ...(removals.length || (additions.length && configs.get(path)!.persons !== undefined)
        ? patchSourceSequence(
            decodeSource(file.bytes),
            "persons",
            additions,
            removals,
            path.endsWith(".json"),
          )
        : []),
      ...[...(navigationSequences.get(path) ?? [])].flatMap(([selector, sequence]) =>
        patchSourceSequence(
          decodeSource(file.bytes),
          selector,
          sequence.additions,
          sequence.removals,
          path.endsWith(".json"),
        ),
      ),
    ].sort(compareSharedEdits);
    if (!edits.length) continue;
    verifySharedEdits(
      file,
      state.project.configurations.find((config) => config.path === path)!,
      state.input.authority.shared.find((authority) => authority.path === path),
      edits,
    );
    const replayed = replaySourceByteEdits(file.bytes, edits);
    // Combined edits must still form one safe mapping. Invalid output is a writer
    // failure, never a parse error attributed to the authored configuration.
    try {
      inspectSourceSyntax(decodeSource(replayed), path.endsWith(".json"));
    } catch (cause) {
      throw new TypeError("Source configuration edits produced invalid syntax", { cause });
    }
    state.modified.set(path, replayed);
    sharedEdits.set(path, edits);
  }
  return sharedEdits;
}

/** Every changed file, each admitted by shared, exclusive or create authority. */
function collectFileChanges(
  state: PlanState,
  sharedEdits: ReadonlyMap<string, readonly SourceByteEdit[]>,
): SourceFileChange[] {
  const { input, files, modified, deleted } = state;
  const changes: SourceFileChange[] = [];
  for (const path of [...new Set([...modified.keys(), ...deleted])].sort()) {
    const old = files.get(path);
    const bytes = deleted.has(path) ? undefined : modified.get(path);
    if (old && bytes && sourceHash(old.bytes) === sourceHash(bytes)) continue;
    if (!sharedEdits.has(path)) {
      if (old) {
        const authority = input.authority.exclusive.find((authority) => authority.path === path);
        if (!authority || authority.sha256 !== sourceHash(old.bytes) || authority.mode !== old.mode)
          block(
            "exclusive-authority-required",
            "Source replacement/deletion requires exact exclusive file authority.",
            undefined,
            path,
          );
      } else if (!input.authority.create.includes(path))
        block(
          "create-authority-required",
          "New files require admitted expected-absence authority.",
          undefined,
          path,
        );
    }
    changes.push({
      kind: old ? (bytes ? "update" : "delete") : "create",
      path,
      base: old ? { sha256: sourceHash(old.bytes), mode: old.mode } : null,
      candidate: bytes
        ? {
            bytes,
            sha256: sourceHash(bytes),
            mode: old?.mode ?? state.createdModes.get(path) ?? "100644",
          }
        : null,
      ...(sharedEdits.has(path) ? { sharedEdits: sharedEdits.get(path) } : {}),
    });
  }
  return changes;
}

/** Compile the candidate tree and require it to reproduce the complete desired graph. */
async function compileCandidate(state: PlanState): Promise<SourceProject> {
  const { files, modified, deleted } = state;
  const tree = state.project.tree
    .filter((file) => !deleted.has(file.path))
    .map((file) => ({ ...file, bytes: modified.get(file.path) ?? file.bytes }));
  for (const [path, bytes] of modified)
    if (!files.has(path) && !deleted.has(path))
      tree.push({ path, mode: state.createdModes.get(path) ?? "100644", bytes });
  const candidate = await readSourceProject({ tree });
  const desired = resourceMap(
    await normalizeSourceResourceReferences([...state.desired.values()], candidate),
  );
  state.desired = desired;
  const compiled = resourceMap(candidate.compilation.resources);
  if (
    compiled.size !== desired.size ||
    [...desired].some(
      ([key, resource]) => !compiled.has(key) || !sameResource(resource, compiled.get(key)!),
    )
  )
    block(
      "round-trip-mismatch",
      "The candidate source does not reproduce the complete desired project graph.",
      [...desired].find(
        ([key, resource]) => !compiled.has(key) || !sameResource(resource, compiled.get(key)!),
      )?.[0],
    );
  return candidate;
}

/** Digest of every input and output the plan depends on, with bytes replaced by hashes. */
function planDigest(
  input: PlanSourceUpdatesInput,
  plan: Omit<SourceUpdatePlan, "planDigest" | "candidate" | "affectedResources">,
): string {
  const evidence = {
    descriptor: SOURCE_WRITER_DESCRIPTOR,
    packageCohort: input.packageCohort,
    baseTreeDigest: plan.baseTreeDigest,
    desiredGraphDigest: plan.desiredGraphDigest,
    candidateTreeDigest: plan.candidateTreeDigest,
    authority: input.authority,
    operations: input.operations,
    referenceContexts: input.referenceContexts ?? {},
    courseReferenceContexts: input.courseReferenceContexts ?? {},
    assetReferenceContexts: input.assetReferenceContexts ?? {},
    derivedRepairs: plan.derivedRepairs,
    assetMappings: plan.assetMappings,
    media: (input.media ?? []).map(({ bytes, ...selection }) => ({
      ...selection,
      bytes: sourceHash(bytes),
    })),
    changes: plan.changes.map((change) => ({
      ...change,
      candidate: change.candidate
        ? { ...change.candidate, bytes: sourceHash(change.candidate.bytes) }
        : null,
      ...(change.sharedEdits
        ? {
            sharedEdits: change.sharedEdits.map((edit) => ({
              ...edit,
              replacement: sourceHash(edit.replacement),
            })),
          }
        : {}),
    })),
  };
  return sourceHash(encodeSource(serializeTopikJson(evidence)));
}

/** The complete candidate is compiled before any applicable file changes are returned. */
export async function planSourceUpdates(input: PlanSourceUpdatesInput): Promise<SourcePlanResult> {
  try {
    checkPlanPins(input);
    const project = await readSourceProject({ tree: input.project.tree });
    const base = resourceMap(project.compilation.resources);
    const desired = resourceMap(structuredClone(input.desiredResources));
    // Course order lives in parent lists, so a page or module must be listed by the parent it
    // names. Missing references keep their own, more specific diagnostics later.
    const membership = validateResourceGraph([...desired.values()]).errors.find(
      (error) => error.id === "membership-inconsistent",
    );
    if (membership)
      block(
        "resource-invalid",
        "Each Course module and page must be listed, once, by the parent it names.",
        membership.resource,
      );
    const savedGraphDigest = digestSourceResourceGraph([...desired.values()]);
    applySourceAssetReferenceContexts(
      [...desired.values()],
      input.assetReferenceContexts,
      input.authority.resources,
    );
    const operationKeys = checkOperations(input, base, desired);
    requireExplicitIntent(input, project, base, desired, operationKeys);
    const state: PlanState = {
      input,
      project,
      base,
      desired,
      operationKeys,
      derivedKeys: new Set(),
      derivedRepairs: [],
      files: new Map(project.tree.map((file) => [file.path, file])),
      paths: new Map(project.documents.map((document) => [document.resource, document.path])),
      originalPaths: new Map(
        project.documents.map((document) => [document.resource, document.path]),
      ),
      reserved: new Set(project.tree.map((file) => file.path)),
      createdModes: new Map(),
      configs: new Map(),
      configUpdates: new Map(),
      navigationUpdates: new Map(),
      personAdditions: new Map(),
      personDeletions: new Map(),
      courseSequenceEdits: new Map(),
      assets: new Map(),
      modified: new Map(),
      deleted: new Set(),
    };
    allocateOperationPaths(state);
    state.configs = inspectConfigurations(project);
    const plannedMedia = planMediaDestinations(state);
    const scope = createReferenceScope(state, plannedMedia);
    prepareReferenceDocuments(state, scope);
    planCourseRepairs(state, scope);
    planWikiRepairs(state, scope);
    restoreReferenceRepairs(state, scope);
    const operations = effectiveOperations(state);
    const assetMappings = applyPlannedMedia(state, plannedMedia);
    for (const op of operations) planOperation(state, scope, op);
    const sharedEdits = planSharedConfigurationEdits(state, planNavigationSequences(state));
    const changes = collectFileChanges(state, sharedEdits);
    const candidate = await compileCandidate(state);
    const plan = {
      descriptor: SOURCE_WRITER_DESCRIPTOR,
      packageCohort: input.packageCohort,
      baseTreeDigest: project.treeDigest,
      desiredGraphDigest: savedGraphDigest,
      candidateTreeDigest: candidate.treeDigest,
      changes,
      derivedRepairs: state.derivedRepairs,
      assetMappings,
    };
    return {
      ok: true,
      plan: {
        descriptor: plan.descriptor,
        packageCohort: plan.packageCohort,
        baseTreeDigest: plan.baseTreeDigest,
        desiredGraphDigest: plan.desiredGraphDigest,
        candidateTreeDigest: plan.candidateTreeDigest,
        planDigest: planDigest(input, plan),
        changes,
        candidate,
        affectedResources: [...new Set([...operationKeys, ...state.derivedKeys])].sort(),
        derivedRepairs: state.derivedRepairs,
        assetMappings,
      },
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: sourcePlanDiagnostics(error, {
        code: "source-validation-failed",
        message:
          "Source planning could not complete. Reinspect the source project before retrying.",
      }),
    };
  }
}

/** Parsed values of every declared source configuration, excluding the manifest. */
function inspectConfigurations(project: SourceProject): Map<string, Record<string, unknown>> {
  const files = new Map(project.tree.map((file) => [file.path, file]));
  return new Map(
    project.configurations
      .filter((config) => config.path !== ".topik.yaml")
      .map((config) => [
        config.path,
        inspectSourceSyntax(
          decodeSource(files.get(config.path)!.bytes),
          config.path.endsWith(".json"),
        ).value,
      ]),
  );
}

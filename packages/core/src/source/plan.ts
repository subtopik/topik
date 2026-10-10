import { posix } from "node:path";
import {
  formatTopikContent,
  rewriteTopikAssetOccurrences,
  rewriteTopikNavigationReferences,
  parseTopikResourceReference,
} from "@topik/content";
import type { Wiki, WikiNavNode } from "@topik/schema/wiki/v1";
import type { Guide } from "@topik/schema/guide/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import { resolveCourseNavigation, type CourseReferenceContext } from "../course-navigation";
import {
  portableCoursePage,
  resolveSourceCourseContext,
  sourceCourseContext,
  planCourseConfiguration,
  transportCourseReferences,
} from "./course";
import { collectMetadataEdits } from "./metadata";
import type { WikiNavNode as SourceWikiNavNode } from "../config/wiki";
import type { Resource } from "../resource";
import type { SourceMediaSelection } from "./initialize";
import { resolveSourceReferenceContext } from "./reference-context";
import {
  normalizeSourceResourceReferences,
  prepareSourceResourceReferences,
  restoreSourceResourceReferences,
} from "./resource-references";
import {
  sourcePlanDiagnostics,
  SourcePlanningError,
  type SourcePlanDiagnostic,
} from "./diagnostics";
export type { SourcePlanDiagnostic } from "./diagnostics";
import {
  applySourceAssetReferenceContexts,
  type SourceAssetReferenceContexts,
} from "./asset-context";
import { validateResources } from "../validate";
import { serializeTopikJson } from "../assets/json";
import { generateAutomaticAssetName } from "../assets/asset";
import { validateTopikPathSet } from "../assets/path";
import { extractMarkdownTitle } from "../compile/shared";
import {
  joinWikiPath,
  resolveWikiNavigation,
  resolveWikiContentHref,
  resolveWikiContentReference,
} from "../wiki-navigation";
import {
  readSourceProject,
  digestSourceTree,
  digestSourceResourceGraph,
  sourceMarkdownSections,
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

type WritableDocument = Guide | WikiPage | CoursePage;
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
  /** Explicit reviewed opt-in; reserved legacy keys still block it. */
  optInConfigs?: readonly string[];
  /** Retained portable context of saved authoring content, before previous source repairs. */
  referenceContexts?: Readonly<Record<string, Wiki>>;
  /** Retained Course route/source snapshots keyed by CoursePage identity. */
  courseReferenceContexts?: Readonly<Record<string, CourseReferenceContext>>;
  assetReferenceContexts?: SourceAssetReferenceContexts;
  media?: readonly (SourceMediaSelection & { config: string })[];
}

function block(code: string, message: string, resource?: string, path?: string): never {
  throw new SourcePlanningError({
    code,
    message,
    ...(resource ? { resource } : {}),
    ...(path ? { path } : {}),
  });
}
const resourceKey = (resource: Resource): string => `${resource.type}/${resource.name}`;
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

function hasSourceContextReferences(page: WritableDocument): boolean {
  let found = false;
  const inspected = rewriteTopikNavigationReferences(
    page.spec.content.value,
    ({ href }) => {
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
      portableCoursePage(a, priorNavigation),
      portableCoursePage(b, savedNavigation),
    );
  }
  if (a.type === "Wiki" && b.type === "Wiki") {
    const portable = (wiki: Wiki) => {
      const value = structuredClone(wiki);
      delete value.spec.sourceVersion;
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
      const navigation = resolveWikiNavigation(context.spec.navigation ?? [], {
        sourceVersion: context.spec.sourceVersion,
      });
      const rewritten = rewriteTopikNavigationReferences(
        page.spec.content.value,
        ({ href }) => {
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
  for (const edit of edits) {
    const fields = edit.selector
      .split(",")
      .map(
        (selector) =>
          admitted.get(selector) ??
          admitted.get(`${selector.slice(0, selector.lastIndexOf("/") + 1)}+`),
      );
    if (fields.some((field) => !field))
      block(
        "shared-scope-denied",
        "A configuration edit exceeds admitted field authority.",
        undefined,
        file.path,
      );
    if (edit.start === edit.end) {
      if (fields.some((field) => field!.insertion !== edit.start || field!.value))
        block(
          "shared-scope-denied",
          "A configuration insertion needs its admitted empty-field anchor.",
          undefined,
          file.path,
        );
    } else {
      const ranges = fields
        .flatMap((field) => [field!.value, field!.entry].filter((range) => range !== undefined))
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

function allocateDocumentPath(
  project: SourceProject,
  directory: string,
  resource: WritableDocument,
): string {
  const slug =
    resource.type === "Guide" || resource.type === "CoursePage"
      ? resource.spec.slug
      : resource.name;
  const stem = posix.join(directory, slug || "index");
  for (const suffix of ["", `-${sourceHash(encodeSource(resource.name)).slice(0, 8)}`]) {
    const candidate = `${stem}${suffix}.md`;
    if (
      !project.tree.some((file) => file.path === candidate) &&
      validateTopikPathSet([...project.tree.map((file) => file.path), candidate]).ok
    )
      return candidate;
  }
  return block(
    "source-path-collision",
    "A new Markdown path collides with the existing project.",
    resourceKey(resource),
  );
}

export function authoredBody(
  resource: WritableDocument,
  path: string,
  assetsByName: ReadonlyMap<string, string>,
): string {
  if (resource.spec.content.format !== "topik")
    block(
      "content-unrepresentable",
      "Only unevaluated Topik content has a source representation.",
      resourceKey(resource),
    );
  const rewrite = rewriteTopikAssetOccurrences(
    resource.spec.content.value,
    (occurrence) => {
      if (!occurrence.reference.startsWith("asset:")) return undefined;
      const assetPath = assetsByName.get(occurrence.reference.slice(6));
      if (!assetPath)
        block(
          "asset-source-missing",
          "An Asset has no proven source path or supplied bytes.",
          resourceKey(resource),
        );
      return posix
        .relative(posix.dirname(path), assetPath)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
    },
    { allowCompiledAssetReferences: true, includeGenericLinkCandidates: true },
  );
  if (!rewrite.ok)
    block(
      "content-unrepresentable",
      "Asset references cannot be written faithfully.",
      resourceKey(resource),
    );
  const formatted = formatTopikContent(rewrite.content);
  if (!formatted.ok)
    block(
      "content-unrepresentable",
      "Content cannot be written faithfully.",
      resourceKey(resource),
    );
  return formatted.formatted;
}

function writeMarkdown(
  base: SourceTreeFile | undefined,
  prior: WritableDocument | undefined,
  desired: WritableDocument,
  version: unknown,
  moved: boolean,
  path: string,
  assets: ReadonlyMap<string, string>,
  sourceContent?: string,
  referenceRepair = false,
): Uint8Array {
  const sections = base ? sourceMarkdownSections(base.bytes) : undefined;
  const oldContent = prior
    ? formatTopikContent(prior.spec.content.value, { allowCompiledAssetReferences: true })
    : undefined;
  const newContent = formatTopikContent(desired.spec.content.value, {
    allowCompiledAssetReferences: true,
  });
  if (!newContent.ok || (oldContent && !oldContent.ok))
    block(
      "content-unrepresentable",
      "Authoring content must remain writable.",
      resourceKey(desired),
    );
  const bodyChanged =
    !oldContent || oldContent.formatted !== newContent.formatted || moved || referenceRepair;
  const body = bodyChanged
    ? authoredBody(
        sourceContent === undefined
          ? desired
          : ({
              ...desired,
              spec: { ...desired.spec, content: { ...desired.spec.content, value: sourceContent } },
            } as WritableDocument),
        path,
        assets,
      )
    : sections!.body;
  const updates: Record<string, unknown> = {};
  if (
    !prior ||
    prior.spec.title !== desired.spec.title ||
    (bodyChanged &&
      !sections?.frontmatter?.match(/^title:/m) &&
      extractMarkdownTitle(body, desired.name) !== desired.spec.title)
  )
    updates.title = desired.spec.title;
  if (desired.type !== "CoursePage") {
    const priorDescription =
      prior && prior.type !== "CoursePage" ? prior.spec.description : undefined;
    if (!prior || priorDescription !== desired.spec.description)
      updates.description = desired.spec.description;
  }
  collectMetadataEdits(updates, "labels", prior?.labels, desired.labels);
  if (moved || !prior) updates.id = desired.name;
  if (desired.type === "Guide") {
    const old = prior?.type === "Guide" ? prior : undefined;
    if (moved || !old || old.spec.slug !== desired.spec.slug) updates.slug = desired.spec.slug;
    if (
      !old ||
      serializeTopikJson(old.spec.authors ?? null) !==
        serializeTopikJson(desired.spec.authors ?? null)
    )
      updates.authors = desired.spec.authors;
    if (
      !old ||
      serializeTopikJson(old.spec.tags ?? null) !== serializeTopikJson(desired.spec.tags ?? null)
    ) {
      updates.tags = desired.spec.tags;
      updates.inheritTags = false;
    }
  }
  if (desired.type === "CoursePage") {
    const old = prior?.type === "CoursePage" ? prior : undefined;
    if (moved || !old || old.spec.slug !== desired.spec.slug) updates.slug = desired.spec.slug;
    if (!old || old.spec.order !== desired.spec.order) updates.order = desired.spec.order;
    if (
      !old ||
      serializeTopikJson(old.spec.authors ?? null) !==
        serializeTopikJson(desired.spec.authors ?? null)
    )
      updates.authors = desired.spec.authors;
  }
  if (
    version !== 1 &&
    Object.keys(updates).some((field) =>
      ["id", "slug", "labels", "inheritTags"].includes(field.split("/")[0]),
    )
  )
    block(
      "source-version-required",
      "This change needs an explicitly reviewed sourceVersion: 1 opt-in.",
      resourceKey(desired),
    );
  const eol = sections?.raw.includes("\r\n") ? "\r\n" : "\n";
  const writtenBody = bodyChanged && eol === "\r\n" ? body.replace(/(?<!\r)\n/g, eol) : body;
  if (!Object.keys(updates).length)
    return encodeSource(
      sections
        ? sections.raw.slice(0, sections.raw.length - sections.body.length) + writtenBody
        : writtenBody,
    );
  if (sections?.frontmatter !== undefined && sections.frontmatterRange) {
    const patched = patchSourceFields(sections.frontmatter, updates);
    return new Uint8Array(
      Buffer.concat([
        base!.bytes.slice(0, sections.frontmatterRange.start),
        patched.bytes,
        base!.bytes.slice(sections.frontmatterRange.end, sections.bodyRange.start),
        encodeSource(writtenBody),
      ]),
    );
  }
  const metadata = Object.entries(updates)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}${eol}`)
    .join("");
  return encodeSource(metadata ? `---${eol}${metadata}---${eol}${writtenBody}` : writtenBody);
}

export function sourceNavigation(
  nodes: readonly WikiNavNode[],
  wiki: Wiki,
  paths: ReadonlyMap<string, string>,
  directory: string,
  prefix = "",
): SourceWikiNavNode[] {
  return nodes.map((node) => {
    if (node.type === "page") {
      const path = paths.get(`WikiPage/${node.page}`);
      if (!path || (directory && !path.startsWith(`${directory}/`)))
        block(
          "source-mapping-missing",
          "Navigation must reference a page owned by its declared source.",
          `Wiki/${wiki.name}`,
        );
      const source = posix.relative(directory || ".", path).replace(/\.mdx?$/i, "");
      const localSlug = node.slug === "" ? "index" : node.slug;
      return {
        type: "page",
        slug: localSlug,
        ...(source !== joinWikiPath(prefix, localSlug) ? { source } : {}),
        ...(node.icon !== undefined ? { icon: node.icon } : {}),
        ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
      };
    }
    return "children" in node
      ? {
          ...node,
          children: sourceNavigation(
            node.children,
            wiki,
            paths,
            directory,
            joinWikiPath(prefix, "slug" in node ? node.slug : undefined),
          ),
        }
      : node;
  });
}

function collectNavigationEdits(
  updates: Record<string, unknown>,
  selector: string,
  raw: unknown,
  previous: unknown,
  desired: unknown,
): void {
  if (serializeTopikJson(previous ?? null) === serializeTopikJson(desired ?? null)) return;
  if (
    Array.isArray(previous) &&
    Array.isArray(desired) &&
    Array.isArray(raw) &&
    previous.length === desired.length &&
    raw.length === previous.length
  ) {
    for (let index = 0; index < desired.length; index++)
      collectNavigationEdits(
        updates,
        `${selector}/${index}`,
        raw[index],
        previous[index],
        desired[index],
      );
  } else if (
    raw &&
    previous &&
    desired &&
    typeof raw === "object" &&
    typeof previous === "object" &&
    typeof desired === "object" &&
    !Array.isArray(raw) &&
    !Array.isArray(previous) &&
    !Array.isArray(desired)
  ) {
    const before = previous as Record<string, unknown>;
    const after = desired as Record<string, unknown>;
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)]))
      collectNavigationEdits(
        updates,
        `${selector}/${encodeURIComponent(field)}`,
        (raw as Record<string, unknown>)[field],
        before[field],
        after[field],
      );
  } else updates[selector] = desired;
}

/** The complete candidate is compiled before any applicable file changes are returned. */
export async function planSourceUpdates(input: PlanSourceUpdatesInput): Promise<SourcePlanResult> {
  try {
    if (!/^[a-f0-9]{64}$/.test(input.packageCohort))
      block("package-cohort-required", "Plans require the verified package cohort integrity.");
    if (
      serializeTopikJson(input.project.descriptor) !== serializeTopikJson(SOURCE_WRITER_DESCRIPTOR)
    )
      block(
        "source-writer-incompatible",
        "The saved source grammar or writer has changed. Reinspect the source project before retrying.",
      );
    if (
      digestSourceTree(input.project.tree) !== input.expectedTreeDigest ||
      input.project.treeDigest !== input.expectedTreeDigest
    )
      block("source-base-changed", "Source bytes no longer match the pinned tree.");
    const project = await readSourceProject({ tree: input.project.tree });
    const base = resourceMap(project.compilation.resources);
    let desired = resourceMap(structuredClone(input.desiredResources));
    const savedGraphDigest = digestSourceResourceGraph([...desired.values()]);
    applySourceAssetReferenceContexts(
      [...desired.values()],
      input.assetReferenceContexts,
      input.authority.resources,
    );
    const derivedRepairs: SourceUpdatePlan["derivedRepairs"][number][] = [];
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
          ))
      )
        block(
          "operation-required",
          "Every changed or deleted resource needs explicit intent.",
          key,
        );
    }
    for (const [key, resource] of desired)
      if (resource.type !== "Asset" && !base.has(key) && !operationKeys.has(key))
        block("operation-required", "Every created resource needs explicit intent.", key);
    const files = new Map(project.tree.map((file) => [file.path, file]));
    const paths = new Map(project.documents.map((document) => [document.resource, document.path]));
    const reserved = new Set(project.tree.map((file) => file.path));
    const createdModes = new Map<string, SourceTreeFile["mode"]>();
    for (const op of input.operations) {
      if (op.kind !== "create" && op.kind !== "move") continue;
      const next = desired.get(op.resource)!;
      if (next.type !== "Guide" && next.type !== "WikiPage" && next.type !== "CoursePage") continue;
      const config =
        op.kind === "create"
          ? op.config
          : project.documents.find((document) => document.resource === op.resource)!.config;
      const source = project.compilation.provenance.find((source) => source.config === config);
      if (!source)
        block("source-mapping-missing", "The operation needs its declared source.", op.resource);
      const path =
        op.path ??
        allocateDocumentPath(
          {
            ...project,
            tree: [...reserved].map((path) => ({ path, mode: "100644", bytes: new Uint8Array() })),
          },
          source.directory,
          next,
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
      if (op.kind === "move")
        createdModes.set(
          path,
          project.documents.find((document) => document.resource === op.resource)!.mode,
        );
    }
    const configs = new Map(
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
    const configUpdates = new Map<string, Record<string, unknown>>();
    const navigationUpdates = new Map<
      string,
      { previous: Wiki; desired: Wiki; directory: string }
    >();
    const personAdditions = new Map<string, unknown[]>();
    const personDeletions = new Map<string, string[]>();
    const courseSequenceEdits = new Map<string, SourceByteEdit[]>();
    for (const config of input.optInConfigs ?? []) {
      const value = configs.get(config);
      if (!value)
        block(
          "source-mapping-missing",
          "Opt-in must name a declared configuration.",
          undefined,
          config,
        );
      if (value.sourceVersion === 1) continue;
      if (value.persons !== undefined || value.labels !== undefined)
        block(
          "source-version-collision",
          "Resolve opaque reserved configuration fields in Git before opting in.",
          undefined,
          config,
        );
      for (const document of project.documents.filter(
        (document) => document.config === config && document.path !== config,
      )) {
        const frontmatter = sourceMarkdownSections(files.get(document.path)!.bytes).frontmatter;
        if (frontmatter) {
          const values = inspectSourceSyntax(frontmatter).value;
          if (["id", "slug", "labels", "inheritTags"].some((field) => Object.hasOwn(values, field)))
            block(
              "source-version-collision",
              "Resolve opaque reserved frontmatter fields in Git before opting in.",
              document.resource,
              document.path,
            );
        }
      }
      configUpdates.set(config, { sourceVersion: 1 });
    }
    const derivedKeys = new Set<string>();
    const originalPaths = new Map(
      project.documents.map((document) => [document.resource, document.path]),
    );
    const referenceDocuments = new Map(
      project.documents.map((document) => [document.resource, document]),
    );
    for (const [key, resource] of desired) {
      if (
        resource.type !== "WikiPage" &&
        resource.type !== "Guide" &&
        resource.type !== "CoursePage"
      )
        continue;
      const path = paths.get(key);
      if (!path) continue;
      const document = referenceDocuments.get(key);
      const creation = input.operations.find(
        (operation): operation is Extract<SourceResourceOperation, { kind: "create" }> =>
          operation.resource === key && operation.kind === "create",
      );
      const config = document?.config ?? creation?.config;
      const directory =
        document?.directory ??
        project.compilation.provenance.find((source) => source.config === config)?.directory ??
        "";
      const prepared = prepareSourceResourceReferences(
        resource,
        document,
        path,
        directory,
        originalPaths,
        paths,
        base,
        desired,
      );
      if (prepared) referenceDocuments.set(key, prepared);
    }
    for (const course of desired.values()) {
      if (course.type !== "Course") continue;
      const document = project.documents.find(
        (document) => document.resource === resourceKey(course),
      );
      const previous = base.get(resourceKey(course));
      if (!document || previous?.type !== "Course")
        block(
          "source-creation-required",
          "Course creation needs explicit source initialization.",
          resourceKey(course),
        );
      const config = document.config;
      const source = project.compilation.provenance.find((source) => source.config === config)!;
      const rawModules = configs.get(config)!.modules as Array<{ id: string; pages: string[] }>;
      const oldPaths = new Map(
        project.documents.map((document) => [document.resource, document.path]),
      );
      const configuration = planCourseConfiguration({
        before: [...base.values()],
        desired: [...desired.values()],
        course,
        originalCourse: previous,
        paths,
        originalPaths: oldPaths,
        directory: source.directory,
        modules: rawModules,
        raw: decodeSource(files.get(config)!.bytes),
        json: config.endsWith(".json"),
      });
      for (const key of configuration.membershipResources) derivedKeys.add(key);
      configUpdates.set(config, { ...configUpdates.get(config), ...configuration.updates });
      if (configuration.edits.length) courseSequenceEdits.set(config, configuration.edits);
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
        if (
          !input.courseReferenceContexts?.[key] &&
          hasSourceContextReferences(page) &&
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
        const context =
          input.courseReferenceContexts?.[key] ??
          (prior?.type === "CoursePage" ? previousContext : currentContext);
        const saved = resolveSourceCourseContext(context, course.name, page.name);
        if (transportCourseReferences(page, saved, currentNavigation, derivedRepairs))
          derivedKeys.add(key);
      }
    }
    for (const resource of desired.values()) {
      if (resource.type !== "Wiki") continue;
      const config = project.documents.find(
        (document) => document.resource === resourceKey(resource),
      )!.config;
      const source = project.compilation.provenance.find((source) => source.config === config)!;
      const previous = base.get(resourceKey(resource)) as Wiki;
      const version =
        configUpdates.get(config)?.sourceVersion ?? configs.get(config)!.sourceVersion;
      if (version === 1) resource.spec.sourceVersion = 1;
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
        derivedKeys.add(resourceKey(resource));
        if (!operationKeys.has(resourceKey(resource)))
          derivedRepairs.push({ resource: resourceKey(resource), kind: "navigation" });
      }
      const currentNavigation = resolveWikiNavigation(resource.spec.navigation ?? [], {
        sourceVersion: resource.spec.sourceVersion,
      });
      for (const page of desired.values()) {
        if (page.type !== "WikiPage" || page.spec.wiki !== resource.name) continue;
        const key = resourceKey(page);
        const priorPage = base.get(key);
        if (
          !input.referenceContexts?.[key] &&
          hasSourceContextReferences(page) &&
          priorPage?.type === "WikiPage" &&
          canonicalResource(priorPage) !==
            canonicalResource({
              ...priorPage,
              spec: { ...priorPage.spec, content: page.spec.content },
            }) &&
          serializeTopikJson({
            navigation: previous.spec.navigation,
            version: previous.spec.sourceVersion,
          }) !==
            serializeTopikJson({
              navigation: resource.spec.navigation,
              version: resource.spec.sourceVersion,
            })
        )
          block(
            "reference-context-required",
            "Changed authoring content needs its retained context when Wiki routes or source grammar change.",
            key,
          );
        const context = resolveSourceReferenceContext(
          input.referenceContexts?.[key] ?? previous,
          resource.name,
          page.name,
        );
        if (!context.ok) block("reference-context-invalid", context.message, key);
        const savedNavigation = context.navigation;
        const rewritten = rewriteTopikNavigationReferences(
          page.spec.content.value,
          (reference) => {
            // Compiled resource references have project-wide identity semantics.
            if (parseTopikResourceReference(reference.href)) return undefined;
            const saved = resolveWikiContentReference(reference.href, page.name, savedNavigation);
            if (saved.kind === "unresolved")
              block(
                "reference-target-unresolved",
                "An authored link has no target in its saved source context.",
                key,
              );
            if (saved.kind !== "page") return undefined;
            const before = saved.target;
            const after = resolveWikiContentHref(reference.href, page.name, currentNavigation);
            if (
              after?.page.page === before.page.page &&
              after.search === before.search &&
              after.hash === before.hash
            )
              return undefined;
            const target = currentNavigation.pageByName.get(before.page.page);
            if (!target)
              block(
                "reference-target-removed",
                "An authored reference still targets a removed page.",
                key,
              );
            const href = `/${target.route.split("/").map(encodeURIComponent).join("/")}${before.search}${before.hash ? `#${before.hash}` : ""}`;
            const proof = resolveWikiContentHref(href, page.name, currentNavigation);
            if (
              proof?.page.page !== before.page.page ||
              proof.search !== before.search ||
              proof.hash !== before.hash
            )
              block(
                "reference-unrepresentable",
                "A source reference cannot preserve its target.",
                key,
              );
            derivedRepairs.push({
              resource: key,
              kind: "reference",
              position: reference.position,
              before: reference.href,
              after: href,
              target: before.page.page,
            });
            return href;
          },
          { allowCompiledAssetReferences: true },
        );
        if (!rewritten.ok)
          block(
            "reference-unrepresentable",
            "Authoring references cannot be rewritten faithfully.",
            key,
          );
        if (rewritten.changes.length) {
          page.spec.content.value = rewritten.content;
          derivedKeys.add(key);
        }
      }
    }
    const referenceRepairKeys = new Set<string>();
    for (const [key, resource] of desired) {
      if (
        resource.type !== "WikiPage" &&
        resource.type !== "Guide" &&
        resource.type !== "CoursePage"
      )
        continue;
      const path = paths.get(key);
      if (!path) continue;
      const restored = restoreSourceResourceReferences(
        resource,
        referenceDocuments.get(key),
        path,
        paths,
        originalPaths,
        base,
        desired,
      );
      if (restored.repairs.length) {
        derivedRepairs.push(...restored.repairs);
        derivedKeys.add(key);
        referenceRepairKeys.add(key);
      }
    }
    const effectiveOperations = [
      ...input.operations,
      ...[...derivedKeys]
        .filter((key) => !operationKeys.has(key))
        .map((resource) => ({ kind: "update" as const, resource })),
    ];
    for (const op of effectiveOperations)
      if (!input.authority.resources.includes(op.resource))
        block(
          "resource-scope-denied",
          "A derived repair exceeds admitted resource scope.",
          op.resource,
        );
    const assets = new Map<string, string>();
    for (const file of project.tree) {
      const generated = generateAutomaticAssetName({
        projectNamespace: project.manifest.namespace,
        manifestRelativePath: file.path,
      });
      if (generated.ok) assets.set(generated.value, file.path);
    }
    const modified = new Map<string, Uint8Array>();
    const deleted = new Set<string>();
    const assetMappings: SourceUpdatePlan["assetMappings"][number][] = [];
    for (const selection of input.media ?? []) {
      const asset = desired.get(`Asset/${selection.name}`);
      const source = project.compilation.provenance.find(
        (source) => source.config === selection.config,
      );
      if (
        asset?.type !== "Asset" ||
        !source ||
        assetMappings.some((mapping) => mapping.from === selection.name) ||
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
      const extension = posix.extname(selection.filename);
      const stem = selection.filename.slice(0, selection.filename.length - extension.length);
      const path = posix.join(
        source.assetDirectory,
        `${stem}-${sourceHash(encodeSource(selection.name)).slice(0, 8)}${extension}`,
      );
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
      assetMappings.push({ from: selection.name, to: identity.value, path });
      asset.name = identity.value;
      assets.set(identity.value, path);
      reserved.add(path);
      modified.set(path, new Uint8Array(selection.bytes));
    }
    if (assetMappings.length) {
      for (const resource of desired.values()) {
        if (
          resource.type !== "Guide" &&
          resource.type !== "WikiPage" &&
          resource.type !== "CoursePage"
        )
          continue;
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
      desired = resourceMap([...desired.values()]);
    }
    for (const op of effectiveOperations) {
      const next = desired.get(op.resource);
      const previous = base.get(op.resource);
      if (
        next &&
        previous &&
        sameResource(previous, next) &&
        op.kind === "update" &&
        !referenceRepairKeys.has(op.resource)
      )
        continue;
      if ((next ?? previous)?.type === "Person") {
        const name = (next ?? previous)!.name;
        for (const authoringResource of [...base.values(), ...desired.values()]) {
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
          derivedKeys.add(key);
        }
        if (op.kind === "move")
          block(
            "resource-unrepresentable",
            "Persons stay inside their declared collection configuration.",
            op.resource,
          );
        const document = project.documents.find((document) => document.resource === op.resource);
        const config = op.kind === "create" ? op.config : document?.config;
        const source = project.compilation.provenance.find((source) => source.config === config);
        if (!config || (source?.kind !== "collection" && source?.kind !== "course"))
          block(
            "source-mapping-missing",
            "A Person needs its exact declared collection or Course source.",
            op.resource,
          );
        if ((configUpdates.get(config)?.sourceVersion ?? configs.get(config)!.sourceVersion) !== 1)
          block("source-version-required", "Persons need sourceVersion: 1.", op.resource);
        const updates = configUpdates.get(config) ?? {};
        const selector = `persons/${encodeURIComponent(op.resource.slice(7))}`;
        if (op.kind === "delete")
          personDeletions.set(config, [...(personDeletions.get(config) ?? []), selector]);
        else if (op.kind === "create") {
          const person = next!;
          personAdditions.set(config, [
            ...(personAdditions.get(config) ?? []),
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
        configUpdates.set(config, updates);
        continue;
      }
      if (op.kind === "delete") {
        if (previous!.type === "CourseModule") {
          if (
            [...desired.values()].some(
              (resource) =>
                resource.type === "CoursePage" && resource.spec.module === previous!.name,
            )
          )
            block(
              "module-not-empty",
              "Delete or reassign every Course page before deleting its module.",
              op.resource,
            );
          continue;
        }
        if (
          previous!.type !== "Guide" &&
          previous!.type !== "WikiPage" &&
          previous!.type !== "CoursePage"
        )
          block(
            "source-deletion-required",
            "Shared sources require explicit source-level deletion authority.",
            op.resource,
          );
        deleted.add(paths.get(op.resource)!);
        continue;
      }
      if (!next)
        block(
          "operation-inconsistent",
          "An update requires its complete desired resource.",
          op.resource,
        );
      if (next!.type === "Wiki") {
        const document = project.documents.find((document) => document.resource === op.resource);
        if (!document || op.kind !== "update" || previous?.type !== "Wiki")
          block(
            "source-creation-required",
            "Wiki creation needs explicit declaration initialization.",
            op.resource,
          );
        const old = previous;
        const updates = configUpdates.get(document.config) ?? {};
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
            navigationUpdates.set(document.config, {
              previous: old,
              desired: next,
              directory: document.directory,
            });
        }
        configUpdates.set(document.config, updates);
        continue;
      }
      if (next.type === "Course") {
        const document = project.documents.find((document) => document.resource === op.resource);
        if (!document || op.kind !== "update" || previous?.type !== "Course")
          block(
            "source-creation-required",
            "Courses remain in their explicitly initialized source configuration.",
            op.resource,
          );
        const updates = configUpdates.get(document.config) ?? {};
        for (const field of ["title", "slug", "description", "authors"] as const)
          collectMetadataEdits(updates, field, previous.spec[field], next.spec[field]);
        collectMetadataEdits(updates, "labels", previous.labels, next.labels);
        configUpdates.set(document.config, updates);
        continue;
      }
      if (next.type === "CourseModule") {
        const config =
          op.kind === "create"
            ? op.config
            : project.documents.find((document) => document.resource === op.resource)?.config;
        const source = project.compilation.provenance.find((source) => source.config === config);
        const course = desired.get(`Course/${next.spec.course}`);
        if (
          !config ||
          source?.kind !== "course" ||
          course?.type !== "Course" ||
          project.documents.find((document) => document.resource === resourceKey(course))
            ?.config !== config ||
          op.kind === "move" ||
          (previous?.type === "CourseModule" && previous.spec.course !== next.spec.course)
        )
          block(
            "source-mapping-missing",
            "Course modules must stay inside their declared Course source.",
            op.resource,
          );
        continue;
      }
      if (next!.type !== "Guide" && next!.type !== "WikiPage" && next!.type !== "CoursePage")
        block(
          "resource-unrepresentable",
          "This resource operation has no admitted source representation.",
          op.resource,
        );
      const document = project.documents.find((document) => document.resource === op.resource);
      const config = op.kind === "create" ? op.config : document!.config;
      const source = project.compilation.provenance.find((source) => source.config === config);
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
      if (next.type === "Guide" && posix.dirname(path) !== (source.directory || "."))
        block(
          "source-path-invalid",
          "Guides must remain beside their declared collection configuration.",
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
        const module = desired.get(`CourseModule/${next.spec.module}`);
        const course =
          module?.type === "CourseModule" ? desired.get(`Course/${module.spec.course}`) : undefined;
        if (
          course?.type !== "Course" ||
          project.documents.find((document) => document.resource === resourceKey(course))
            ?.config !== config
        )
          block(
            "source-mapping-missing",
            "A Course page must belong to a module in its declared source.",
            op.resource,
          );
      }
      const version =
        configUpdates.get(config)?.sourceVersion ?? configs.get(config)!.sourceVersion;
      modified.set(
        path,
        writeMarkdown(
          document ? files.get(document.path) : undefined,
          previous as WritableDocument | undefined,
          next,
          version,
          op.kind === "move",
          path,
          assets,
          restoreSourceResourceReferences(
            next,
            referenceDocuments.get(op.resource),
            path,
            paths,
            originalPaths,
            base,
            desired,
          ).content,
          referenceRepairKeys.has(op.resource),
        ),
      );
      if (op.kind === "move") deleted.add(document!.path);
    }
    const oldPaths = new Map(
      project.documents.map((document) => [document.resource, document.path]),
    );
    for (const [config, { previous, desired: wiki, directory }] of navigationUpdates) {
      const updates = configUpdates.get(config)!;
      collectNavigationEdits(
        updates,
        "navigation",
        configs.get(config)!.navigation,
        sourceNavigation(previous.spec.navigation ?? [], previous, oldPaths, directory),
        sourceNavigation(wiki.spec.navigation ?? [], wiki, paths, directory),
      );
    }
    const sharedEdits = new Map<string, readonly SourceByteEdit[]>();
    for (const [path, updates] of configUpdates) {
      const file = files.get(path)!;
      const additions = personAdditions.get(path) ?? [];
      const removals = personDeletions.get(path) ?? [];
      if (additions.length && configs.get(path)!.persons === undefined) updates.persons = additions;
      const patch = patchSourceFields(decodeSource(file.bytes), updates, path.endsWith(".json"));
      const edits = [
        ...(courseSequenceEdits.get(path) ?? []),
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
      ].sort(compareSharedEdits);
      if (!edits.length) continue;
      verifySharedEdits(
        file,
        project.configurations.find((config) => config.path === path)!,
        input.authority.shared.find((authority) => authority.path === path),
        edits,
      );
      modified.set(path, replaySourceByteEdits(file.bytes, edits));
      sharedEdits.set(path, edits);
    }
    const changes: SourceFileChange[] = [];
    for (const path of [...new Set([...modified.keys(), ...deleted])].sort()) {
      const old = files.get(path);
      const bytes = deleted.has(path) ? undefined : modified.get(path);
      if (old && bytes && sourceHash(old.bytes) === sourceHash(bytes)) continue;
      if (!sharedEdits.has(path)) {
        if (old) {
          const authority = input.authority.exclusive.find((authority) => authority.path === path);
          if (
            !authority ||
            authority.sha256 !== sourceHash(old.bytes) ||
            authority.mode !== old.mode
          )
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
              mode: old?.mode ?? createdModes.get(path) ?? "100644",
            }
          : null,
        ...(sharedEdits.has(path) ? { sharedEdits: sharedEdits.get(path) } : {}),
      });
    }
    const tree = project.tree
      .filter((file) => !deleted.has(file.path))
      .map((file) => ({ ...file, bytes: modified.get(file.path) ?? file.bytes }));
    for (const [path, bytes] of modified)
      if (!files.has(path) && !deleted.has(path))
        tree.push({ path, mode: createdModes.get(path) ?? "100644", bytes });
    const candidate = await readSourceProject({ tree });
    desired = resourceMap(
      await normalizeSourceResourceReferences([...desired.values()], candidate),
    );
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
    const desiredGraphDigest = savedGraphDigest;
    const evidence = {
      descriptor: SOURCE_WRITER_DESCRIPTOR,
      packageCohort: input.packageCohort,
      baseTreeDigest: project.treeDigest,
      desiredGraphDigest,
      candidateTreeDigest: candidate.treeDigest,
      authority: input.authority,
      operations: input.operations,
      optInConfigs: input.optInConfigs ?? [],
      referenceContexts: input.referenceContexts ?? {},
      courseReferenceContexts: input.courseReferenceContexts ?? {},
      assetReferenceContexts: input.assetReferenceContexts ?? {},
      derivedRepairs,
      assetMappings,
      media: (input.media ?? []).map(({ bytes, ...selection }) => ({
        ...selection,
        bytes: sourceHash(bytes),
      })),
      changes: changes.map((change) => ({
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
    return {
      ok: true,
      plan: {
        descriptor: SOURCE_WRITER_DESCRIPTOR,
        packageCohort: input.packageCohort,
        baseTreeDigest: project.treeDigest,
        desiredGraphDigest,
        candidateTreeDigest: candidate.treeDigest,
        planDigest: sourceHash(encodeSource(serializeTopikJson(evidence))),
        changes,
        candidate,
        affectedResources: [...new Set([...operationKeys, ...derivedKeys])].sort(),
        derivedRepairs,
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

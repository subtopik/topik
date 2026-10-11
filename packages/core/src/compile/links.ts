import type {
  AnalyzeTopikContentResult,
  TopikContentDiagnostic,
  TopikContentLink,
  TopikResourceReference,
} from "@topik/content";
import {
  analyzeTopikContent,
  parseTopikResourceReference,
  rewriteTopikNavigationReferences,
  serializeTopikResourceReference,
  topikLinkDiagnosticMessage,
  validateTopikAssetReference,
} from "@topik/content";
import { posix } from "node:path";
import { classifyPortableNavigationPath, readPortableAssetFile } from "../assets/files";
import { resolveSourceReferencePath } from "../reference-paths";
import { folderLandingCandidates, isFolderHref, resolveDeclaredPublicRoute } from "../folder-links";
import {
  resolveCourseContentHref,
  resolveCourseNavigation,
  type ResolvedCourseNavigation,
} from "../course-navigation";
import type { SourceResource } from "../resource";
import { PublicCompileError } from "./public-errors";
import {
  linkValidationPolicy,
  type CompileValidationOptions,
  type LinkValidationPolicy,
} from "./shared";
import {
  resolveWikiContentHref,
  resolveWikiNavigation,
  type ResolvedWikiNavigation,
} from "../wiki-navigation";

/** Optional application-provided catalogue; Topik never fetches targets. */
export interface CompileResourceReferenceTarget {
  type: TopikResourceReference["type"];
  name: string;
  /** Published heading IDs, when known. Without them a fragment remains deferred. */
  headings?: readonly string[];
}

export interface CompiledResourceReference {
  resource: string;
  sourcePath: string;
  kind: "link" | "card";
  position: string;
  /** The original authored destination, retained for source round trips. */
  href: string;
  reference: TopikResourceReference;
  status: "verified" | "deferred" | "invalid";
}

export interface CompileResourceLinksInput {
  rootDir: string;
  resources: readonly SourceResource[];
  sourcePathsByResource: Readonly<Record<string, string>>;
  sourceDirectoriesByResource?: Readonly<Record<string, string>>;
  referenceTargets?: readonly CompileResourceReferenceTarget[];
  /** @internal Source round-trip comparison may already contain compiled Asset locators. */
  allowCompiledAssetReferences?: boolean;
  validation?: CompileValidationOptions;
}

type DocumentResource = Extract<SourceResource, { type: "WikiPage" | "Guide" | "CoursePage" }>;
type ReferenceResource = DocumentResource;

/** Resolve document identity after all declared sources have been discovered, before Assets. */
export async function compileResourceLinks(input: CompileResourceLinksInput): Promise<{
  resources: SourceResource[];
  diagnostics: TopikContentDiagnostic[];
  references: CompiledResourceReference[];
}> {
  const policy = linkValidationPolicy(input.validation);
  const diagnostics: TopikContentDiagnostic[] = [];
  const references: CompiledResourceReference[] = [];
  const analyses = new Map<string, AnalyzeTopikContentResult>();
  const localTargets = new Map<string, ReferenceResource>();
  const targetsByPath = new Map<string, ReferenceResource[]>();
  const targetsByExtensionlessPath = new Map<string, ReferenceResource[]>();
  const catalogues = new Map<string, CompileResourceReferenceTarget[]>();
  const navigation = new Map<string, ResolvedWikiNavigation>();
  const courseNavigationByPage = new Map<string, ResolvedCourseNavigation>();
  const documents = input.resources.filter(isDocumentResource).sort((left, right) => {
    const leftKey = resourceKey(left);
    const rightKey = resourceKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  for (const resource of input.resources) {
    if (resource.type === "Wiki")
      navigation.set(
        resource.name,
        resolveWikiNavigation(resource.spec.navigation ?? [], {
          sourceVersion: resource.spec.sourceVersion,
        }),
      );
  }
  for (const resource of documents) {
    const key = resourceKey(resource);
    const sourcePath = input.sourcePathsByResource[key];
    if (sourcePath === undefined || resource.spec.content.format !== "topik") continue;
    analyses.set(key, analyzeTopikContent(resource.spec.content.value, { file: sourcePath }));
    localTargets.set(key, resource);
    const targets = targetsByPath.get(sourcePath) ?? [];
    targets.push(resource);
    targetsByPath.set(sourcePath, targets);
    const extensionlessPath = stripMarkdownExtension(sourcePath);
    const extensionlessTargets = targetsByExtensionlessPath.get(extensionlessPath) ?? [];
    extensionlessTargets.push(resource);
    targetsByExtensionlessPath.set(extensionlessPath, extensionlessTargets);
  }
  for (const target of admitReferenceTargets(input.referenceTargets)) {
    const key = resourceKey(target);
    const entries = catalogues.get(key) ?? [];
    entries.push(target);
    catalogues.set(key, entries);
  }
  for (const course of input.resources.filter((resource) => resource.type === "Course")) {
    const modules = input.resources.filter(
      (resource): resource is Extract<SourceResource, { type: "CourseModule" }> =>
        resource.type === "CourseModule" && resource.spec.course === course.name,
    );
    const moduleNames = new Set(modules.map((module) => module.name));
    const pages = documents.filter(
      (resource): resource is Extract<DocumentResource, { type: "CoursePage" }> =>
        resource.type === "CoursePage" && moduleNames.has(resource.spec.module),
    );
    const resolved = resolveCourseNavigation({
      course: course.name,
      modules: modules.map((module) => ({ name: module.name, slug: module.spec.slug })),
      pages: pages.map((page) => {
        const key = resourceKey(page);
        const directory = input.sourceDirectoriesByResource?.[key] ?? "";
        const path = stripMarkdownExtension(input.sourcePathsByResource[key]);
        return {
          name: page.name,
          module: page.spec.module,
          slug: page.spec.slug,
          sourcePath: directory ? path.slice(directory.length + 1) : path,
        };
      }),
    });
    for (const page of pages) courseNavigationByPage.set(page.name, resolved);
  }

  const existingPaths = new Map<string, boolean>();
  const directories = new Map<string, boolean>();
  const isDirectory = async (path: string): Promise<boolean> => {
    let result = directories.get(path);
    if (result === undefined) {
      result =
        path === "" ||
        (await classifyPortableNavigationPath({ root: input.rootDir, path })) === "directory";
      directories.set(path, result);
    }
    return result;
  };
  const hasNonPageFile = async (path: string): Promise<boolean> => {
    let exists = existingPaths.get(path);
    if (exists === undefined) {
      if (await isDirectory(path)) return false;
      const proof = await readPortableAssetFile({ root: input.rootDir, path });
      exists =
        proof?.ok === true ||
        proof?.diagnostics.some((diagnostic) => diagnostic.id !== "TOPIK_ASSET_FILE_MISSING") ===
          true;
      existingPaths.set(path, exists);
    }
    return exists;
  };
  const compiledByKey = new Map<string, DocumentResource>();
  for (const resource of documents) {
    const key = resourceKey(resource);
    const sourcePath = input.sourcePathsByResource[key];
    const analysis = analyses.get(key);
    if (!analysis || sourcePath === undefined) continue;
    const directory = input.sourceDirectoriesByResource?.[key] ?? "";
    const replacements = new Map<
      string,
      { reference: TopikResourceReference; status: CompiledResourceReference["status"] }
    >();

    for (const link of analysis.links) {
      const explicit = parseTopikResourceReference(link.href);
      if (explicit) {
        const targetKey = resourceKey(explicit);
        const target = localTargets.get(targetKey);
        const entries = catalogues.get(targetKey);
        let status: CompiledResourceReference["status"] = "deferred";
        if (target) {
          status = validateFragment(
            explicit.hash,
            analyses.get(targetKey)?.headings.map((heading) => heading.id) ?? [],
            link,
            policy,
            diagnostics,
          );
        } else if (entries?.length === 1) {
          const headings = entries[0].headings;
          status =
            explicit.hash && headings === undefined
              ? "deferred"
              : validateFragment(explicit.hash, headings ?? [], link, policy, diagnostics);
        } else if (entries && entries.length > 1) {
          status = "invalid";
          appendLinkDiagnostic("link-reference-ambiguous", link, policy, diagnostics);
        }
        replacements.set(navigationReferenceKey(link), { reference: explicit, status });
        continue;
      }
      if (NON_PAGE_SCHEME.test(link.href) || link.href.startsWith("//")) continue;
      if (link.href.startsWith("#")) {
        if (link.href !== "#" && (resource.type !== "CoursePage" || link.kind === "link"))
          validateFragment(
            link.href.slice(1),
            analysis.headings.map((heading) => heading.id),
            link,
            policy,
            diagnostics,
          );
        continue;
      }
      const path = resolveSourceReferencePath(link.href, sourcePath, directory);
      const markdown = /\.(?:mdx?|markdown)$/i.test(path ?? link.href.split(/[?#]/, 1)[0]);
      const extensionless = path !== undefined && posix.extname(path) === "";
      const folderSpelling = isFolderHref(link.href);
      if (folderSpelling && path === undefined) {
        appendLinkDiagnostic("link-page-not-found", link, policy, diagnostics);
        continue;
      }
      // Extensionless absolute links retain their public-route contract. An explicit
      // trailing slash instead selects a configuration-relative source folder.
      const routeNavigation =
        resource.type === "CoursePage"
          ? courseNavigationByPage.get(resource.name)
          : resource.type === "WikiPage"
            ? navigation.get(resource.spec.wiki)
            : undefined;
      const routeTarget =
        path !== undefined && routeNavigation
          ? resolveDeclaredPublicRoute<unknown>(
              link.href,
              routeNavigation.pageByRoute,
              resource.type === "WikiPage",
            )
          : undefined;
      const folder =
        path !== undefined &&
        !routeTarget &&
        ((folderSpelling && (resource.type !== "Guide" || !link.href.startsWith("/"))) ||
          (await isDirectory(path)));
      const landingPages =
        folder && path !== undefined
          ? folderLandingCandidates(path, targetsByExtensionlessPath).flat()
          : [];
      if (folder && landingPages.length !== 1) {
        appendLinkDiagnostic(
          landingPages.length ? "link-reference-ambiguous" : "link-page-not-found",
          link,
          policy,
          diagnostics,
        );
        continue;
      }
      if (!folder && path !== undefined && extensionless && link.kind === "link") {
        const asset = validateTopikAssetReference(link.href);
        // A real download keeps its Asset semantics even when a document shares its stem.
        // Leave unsupported files to the Asset pipeline so its safety checks still apply.
        if (asset.valid && asset.kind === "local" && (await hasNonPageFile(path))) continue;
      }
      const candidates =
        path === undefined || (link.href.startsWith("/") && !markdown)
          ? undefined
          : markdown
            ? targetsByPath.get(path)
            : extensionless
              ? targetsByExtensionlessPath.get(path)
              : undefined;
      let target = folder ? landingPages[0] : candidates?.length === 1 ? candidates[0] : undefined;
      // The root route has no portable file path; admit only the literal route, not
      // paths that normalize outside the source root and happen to resolve to it as URLs.
      const rootRoute = link.href.split(/[?#]/, 1)[0] === "/";
      if (!target && (extensionless || rootRoute) && resource.type === "WikiPage") {
        const resolved = navigation.get(resource.spec.wiki);
        const wikiTarget = resolved && resolveWikiContentHref(link.href, resource.name, resolved);
        if (wikiTarget) target = localTargets.get(`WikiPage/${wikiTarget.page.page}`);
      }
      if (!target && path !== undefined && !markdown && resource.type === "CoursePage") {
        const resolved = courseNavigationByPage.get(resource.name);
        const courseTarget =
          resolved && resolveCourseContentHref(link.href, resource.name, resolved);
        // Logical Course sources may contain dots. Actual non-Markdown files
        // retain download precedence for links, while cards identify pages.
        if (
          courseTarget &&
          (extensionless || link.kind === "card" || !(await hasNonPageFile(path)))
        )
          target = localTargets.get(`CoursePage/${courseTarget.page.page}`);
      }
      if (target) {
        const url = new URL(link.href, LINK_BASE);
        const reference: TopikResourceReference = {
          type: target.type,
          name: target.name,
          search: url.search,
          hash: url.hash.slice(1),
        };
        const status = validateFragment(
          reference.hash,
          analyses.get(resourceKey(target))?.headings.map((heading) => heading.id) ?? [],
          link,
          policy,
          diagnostics,
        );
        replacements.set(navigationReferenceKey(link), { reference, status });
        continue;
      }
      // Guides retain application URL links, while Markdown source links must be declared.
      if (resource.type === "CoursePage") {
        if (link.kind !== "link") continue;
      }
      if (
        resource.type === "Guide" &&
        !markdown &&
        (!folderSpelling || (link.href.startsWith("/") && path !== undefined))
      )
        continue;
      if (!markdown && path !== undefined && link.kind === "link") {
        if (await hasNonPageFile(path)) continue;
      }
      appendLinkDiagnostic("link-page-not-found", link, policy, diagnostics);
    }

    if (replacements.size === 0) continue;
    const rewritten = rewriteTopikNavigationReferences(
      resource.spec.content.value,
      (navigationReference) => {
        const replacement = replacements.get(navigationReferenceKey(navigationReference));
        if (!replacement) return undefined;
        references.push({
          resource: key,
          sourcePath,
          ...navigationReference,
          reference: replacement.reference,
          status: replacement.status,
        });
        return serializeTopikResourceReference(replacement.reference);
      },
      { file: sourcePath, allowCompiledAssetReferences: input.allowCompiledAssetReferences },
    );
    if (!rewritten.ok) {
      diagnostics.push(...rewritten.diagnostics);
      continue;
    }
    compiledByKey.set(key, {
      ...resource,
      spec: { ...resource.spec, content: { ...resource.spec.content, value: rewritten.content } },
    } as DocumentResource);
  }
  return {
    resources: input.resources.map(
      (resource) => compiledByKey.get(resourceKey(resource)) ?? resource,
    ),
    diagnostics,
    references,
  };
}

function validateFragment(
  hash: string,
  headings: readonly string[],
  link: TopikContentLink,
  policy: LinkValidationPolicy,
  diagnostics: TopikContentDiagnostic[],
): CompiledResourceReference["status"] {
  if (hash && !headings.includes(decodeFragment(hash))) {
    appendLinkDiagnostic("link-fragment-not-found", link, policy, diagnostics);
    return "invalid";
  }
  return "verified";
}

function appendLinkDiagnostic(
  id: string,
  link: TopikContentLink,
  policy: LinkValidationPolicy,
  diagnostics: TopikContentDiagnostic[],
): void {
  if (policy !== "off")
    diagnostics.push(linkDiagnostic(id, policy === "error" ? "error" : "warning", link));
}

function admitReferenceTargets(value: unknown): readonly CompileResourceReferenceTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PublicCompileError("reference-targets-invalid");
  for (const target of value) {
    if (
      target === null ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      (target.type !== "WikiPage" && target.type !== "Guide" && target.type !== "CoursePage") ||
      typeof target.name !== "string" ||
      target.name.length > 63 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.name) ||
      (target.headings !== undefined &&
        (!Array.isArray(target.headings) ||
          target.headings.some((heading: unknown) => typeof heading !== "string")))
    )
      throw new PublicCompileError("reference-targets-invalid");
  }
  return value;
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.(?:mdx?|markdown)$/i, "");
}

function isDocumentResource(resource: SourceResource): resource is DocumentResource {
  return (
    resource.type === "WikiPage" || resource.type === "Guide" || resource.type === "CoursePage"
  );
}

function resourceKey(resource: { type: string; name: string }): string {
  return `${resource.type}/${resource.name}`;
}

function navigationReferenceKey(reference: Pick<TopikContentLink, "kind" | "href">): string {
  // The same href can be a download in a Markdown link and a page destination in a card.
  return `${reference.kind}:${reference.href}`;
}

const NON_PAGE_SCHEME = /^(?:asset|https?|mailto|tel):/i;
const LINK_BASE = "https://topik.local";

function decodeFragment(value: string): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function linkDiagnostic(
  id: string,
  level: "error" | "warning",
  link: TopikContentLink,
): TopikContentDiagnostic {
  const message = topikLinkDiagnosticMessage(id);
  if (message === undefined) throw new TypeError("Unknown link diagnostic identifier");
  return {
    id,
    type: link.kind,
    level,
    message,
    lines: link.lines,
    ...(link.file ? { file: link.file } : {}),
  };
}

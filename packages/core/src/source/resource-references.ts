import { posix } from "node:path";
import {
  parseTopikResourceReference,
  rewriteTopikNavigationReferences,
  serializeTopikResourceReference,
  type TopikNavigationReference,
} from "@topik/content";
import type { Resource } from "../resource";
import { resolveWikiContentHref, resolveWikiNavigation } from "../wiki-navigation";
import { SourcePlanningError } from "./diagnostics";
import { withSourceScratch, type SourceDocumentProvenance, type SourceProject } from "./project";
import { compileResourceLinks } from "../compile/links";
import {
  isSourceNonPageReference,
  isSourceFolderReference,
  resolveSourceReferencePath,
  sourcePathInventory,
} from "../reference-paths";
import { folderLandingCandidates, resolveDeclaredPublicRoute } from "../folder-links";
import { resolveCourseContentHref, resolveCourseNavigation } from "../course-navigation";
import { sourceCourseContext } from "./course";

type ContentResource = Extract<Resource, { type: "WikiPage" | "Guide" | "CoursePage" }>;
function courseName(
  resource: ContentResource,
  resources: ReadonlyMap<string, Resource>,
): string | undefined {
  if (resource.type !== "CoursePage") return undefined;
  const module = resources.get(`CourseModule/${resource.spec.module}`);
  return module?.type === "CourseModule" ? module.spec.course : undefined;
}

function sourcePublicRouteTarget(
  resource: ContentResource,
  href: string,
  paths: ReadonlyMap<string, string>,
  resources: ReadonlyMap<string, Resource>,
): ContentResource | undefined {
  if (!href.startsWith("/")) return undefined;
  if (resource.type === "WikiPage") {
    const wiki = resources.get(`Wiki/${resource.spec.wiki}`);
    if (wiki?.type !== "Wiki") return undefined;
    const navigation = resolveWikiNavigation(wiki.spec.navigation ?? [], {
      sourceVersion: wiki.spec.sourceVersion,
    });
    const page = resolveDeclaredPublicRoute(href, navigation.pageByRoute, true);
    const target = page && resources.get(`WikiPage/${page.page}`);
    return target?.type === "WikiPage" ? target : undefined;
  }
  if (resource.type !== "CoursePage") return undefined;
  const course = resources.get(`Course/${courseName(resource, resources)}`);
  const config = course && paths.get(`Course/${course.name}`);
  if (course?.type !== "Course" || !config) return undefined;
  const directory = posix.dirname(config);
  const navigation = resolveCourseNavigation(
    sourceCourseContext([...resources.values()], course, paths, directory === "." ? "" : directory),
  );
  const page = resolveDeclaredPublicRoute(href, navigation.pageByRoute);
  const target = page && resources.get(`CoursePage/${page.page}`);
  return target?.type === "CoursePage" ? target : undefined;
}
export interface SourceReferenceRepair {
  resource: string;
  kind: "reference";
  position: string;
  before: string;
  after: string;
  target: string;
}

/** Interpret freshly supplied source paths before a scope-local Wiki/Course transport pass. */
export function prepareSourceResourceReferences(
  resource: ContentResource,
  document: SourceDocumentProvenance | undefined,
  path: string,
  directory: string,
  originalPaths: ReadonlyMap<string, string>,
  currentPaths: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, Resource>,
  desired: ReadonlyMap<string, Resource>,
  originalInventory: ReadonlySet<string>,
  currentInventory: ReadonlySet<string>,
): SourceDocumentProvenance | undefined {
  const supplied: SourceDocumentProvenance["references"][number][] = [];
  const rewritten = rewriteTopikNavigationReferences(
    resource.spec.content.value,
    (reference) => {
      if (
        parseTopikResourceReference(reference.href) ||
        reference.href.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(reference.href) ||
        isSourceNonPageReference(reference, document?.path ?? path, directory, originalInventory)
      )
        return undefined;
      // Preserve public-route interpretation for scope-local transport, including
      // when a different declared source has a folder at the same filesystem path.
      if (sourcePublicRouteTarget(resource, reference.href, originalPaths, base)) return undefined;
      const originalTarget = resolveSourcePathReference(
        reference.href,
        document?.path ?? path,
        directory,
        originalPaths,
        base,
        originalInventory,
      );
      // A new directory cannot replace an already established page destination.
      if (
        !originalTarget &&
        isSourceNonPageReference(reference, document?.path ?? path, directory, currentInventory)
      )
        return undefined;
      const target =
        originalTarget ??
        (sourcePublicRouteTarget(resource, reference.href, currentPaths, desired)
          ? undefined
          : resolveSourcePathReference(
              reference.href,
              document?.path ?? path,
              directory,
              currentPaths,
              desired,
              currentInventory,
            ));
      if (
        !target ||
        (resource.type === "WikiPage" &&
          target.type === "WikiPage" &&
          resource.spec.wiki === target.spec.wiki) ||
        (resource.type === "CoursePage" &&
          target.type === "CoursePage" &&
          courseName(resource, desired) === courseName(target, desired))
      )
        return undefined;
      const url = new URL(reference.href, "https://topik.invalid");
      const identity = {
        type: target.type,
        name: target.name,
        search: url.search,
        hash: url.hash.slice(1),
      };
      supplied.push({
        ...reference,
        target: `${identity.type}/${identity.name}`,
        search: identity.search,
        hash: identity.hash,
      });
      return serializeTopikResourceReference(identity);
    },
    { allowCompiledAssetReferences: true },
  );
  if (!rewritten.ok)
    throw new SourcePlanningError({
      code: "reference-unrepresentable",
      message: "Source resource references cannot be interpreted faithfully.",
      resource: `${resource.type}/${resource.name}`,
    });
  resource.spec.content.value = rewritten.content;
  if (!document || !supplied.length) return document;
  return {
    ...document,
    references: [
      ...supplied,
      ...document.references.filter(
        (saved) =>
          !supplied.some(
            (reference) => reference.kind === saved.kind && reference.position === saved.position,
          ),
      ),
    ],
  };
}

/** Resolve only declared Markdown source paths, preserving exact file extensions. */
export function resolveSourcePathReference(
  href: string,
  sourcePath: string,
  directory: string,
  paths: ReadonlyMap<string, string>,
  resources: ReadonlyMap<string, Resource>,
  inventory: ReadonlySet<string> = sourcePathInventory(paths.values()),
): ContentResource | undefined {
  if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
    return undefined;
  const path = resolveSourceReferencePath(href, sourcePath, directory);
  if (path === undefined) return undefined;
  if (isSourceFolderReference(href, sourcePath, directory, inventory)) {
    const pages = new Map<string, ContentResource[]>();
    for (const [key, source] of paths) {
      const resource = resources.get(key);
      if (
        !resource ||
        (resource.type !== "WikiPage" &&
          resource.type !== "Guide" &&
          resource.type !== "CoursePage") ||
        !/\.(?:mdx?|markdown)$/i.test(source)
      )
        continue;
      const stem = source.replace(/\.(?:mdx?|markdown)$/i, "");
      pages.set(stem, [...(pages.get(stem) ?? []), resource]);
    }
    const candidates = folderLandingCandidates(path, pages).flat();
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  if (href.startsWith("/") && !/\.(?:mdx?|markdown)$/i.test(path)) return undefined;
  return findSourceReferenceTarget(path, paths, resources);
}

/** Candidate filesystem precedence must still agree with the selected page identity. */
export function isSourceReferenceShadowed(
  resource: ContentResource,
  reference: Pick<TopikNavigationReference, "href" | "kind">,
  path: string,
  directory: string,
  paths: ReadonlyMap<string, string>,
  resources: ReadonlyMap<string, Resource>,
  inventory: ReadonlySet<string>,
  target: string,
): boolean {
  const publicTarget = sourcePublicRouteTarget(resource, reference.href, paths, resources);
  if (publicTarget) return `${publicTarget.type}/${publicTarget.name}` !== target;
  if (isSourceNonPageReference(reference, path, directory, inventory)) return true;
  if (!isSourceFolderReference(reference.href, path, directory, inventory)) return false;
  const page = resolveSourcePathReference(
    reference.href,
    path,
    directory,
    paths,
    resources,
    inventory,
  );
  return !page || `${page.type}/${page.name}` !== target;
}

function findSourceReferenceTarget(
  path: string,
  paths: ReadonlyMap<string, string>,
  resources: ReadonlyMap<string, Resource>,
): ContentResource | undefined {
  const exact = [...paths].filter(([, sourcePath]) => sourcePath === path);
  // An explicit extension names a file, rather than a logical stem shared by .md and .mdx.
  const candidates =
    exact.length || posix.extname(path) !== ""
      ? exact
      : [...paths].filter(
          ([, sourcePath]) => sourcePath.replace(/\.(?:mdx?|markdown)$/i, "") === path,
        );
  const targets = candidates
    .map(([key]) => resources.get(key))
    .filter(
      (resource): resource is ContentResource =>
        resource?.type === "WikiPage" ||
        resource?.type === "Guide" ||
        resource?.type === "CoursePage",
    );
  return targets.length === 1 ? targets[0] : undefined;
}

/** Accept retained authoring links while comparing against the canonical compiled graph. */
export async function normalizeSourceResourceReferences(
  resources: readonly Resource[],
  project: SourceProject,
): Promise<Resource[]> {
  const sourcePathsByResource: Record<string, string> = {};
  const sourceDirectoriesByResource: Record<string, string> = {};
  for (const document of project.documents) {
    sourcePathsByResource[document.resource] = document.path;
    sourceDirectoriesByResource[document.resource] = document.directory;
  }
  const linked = await withSourceScratch(project.tree, (rootDir) =>
    compileResourceLinks({
      rootDir,
      resources: resources.filter((resource) => resource.type !== "Asset"),
      sourcePathsByResource,
      sourceDirectoriesByResource,
      allowCompiledAssetReferences: true,
    }),
  );
  const byKey = new Map(
    linked.resources.map((resource) => [`${resource.type}/${resource.name}`, resource]),
  );
  return resources.map((resource) => byKey.get(`${resource.type}/${resource.name}`) ?? resource);
}

/** Restore source spelling at the write boundary without changing compiled resource identities. */
export function restoreSourceResourceReferences(
  resource: ContentResource,
  document: SourceDocumentProvenance | undefined,
  path: string,
  paths: ReadonlyMap<string, string>,
  originalPaths: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, Resource>,
  desired: ReadonlyMap<string, Resource>,
  currentInventory: ReadonlySet<string>,
): { content: string; repairs: SourceReferenceRepair[] } {
  const key = `${resource.type}/${resource.name}`;
  const repairs: SourceReferenceRepair[] = [];
  const used = new Set<SourceDocumentProvenance["references"][number]>();
  const rewritten = rewriteTopikNavigationReferences(
    resource.spec.content.value,
    (reference) => {
      const identity = parseTopikResourceReference(reference.href);
      if (!identity) return undefined;
      const targetKey = `${identity.type}/${identity.name}`;
      if (base.has(targetKey) && !desired.has(targetKey))
        throw new SourcePlanningError({
          code: "reference-target-removed",
          message: "A resource reference still targets a removed resource.",
          resource: key,
        });
      const matches = (saved: SourceDocumentProvenance["references"][number]) =>
        !used.has(saved) &&
        saved.kind === reference.kind &&
        saved.target === targetKey &&
        (saved.search ?? "") === identity.search &&
        (saved.hash ?? "") === identity.hash;
      const saved =
        document?.references.find(
          (saved) => saved.position === reference.position && matches(saved),
        ) ?? document?.references.find(matches);
      if (!saved) return undefined;
      used.add(saved);
      if (parseTopikResourceReference(saved.href)) return saved.href;

      const destination = paths.get(targetKey);
      if (!destination) return undefined;
      const target = desired.get(targetKey);
      const suffix = `${identity.search}${identity.hash ? `#${identity.hash}` : ""}`;
      let href = saved.href;
      // Candidate routes and filesystem paths must still identify the saved target.
      const shadowed = () =>
        isSourceReferenceShadowed(
          resource,
          saved,
          path,
          document?.directory ?? "",
          paths,
          desired,
          currentInventory,
          targetKey,
        );
      let unchangedContext =
        !shadowed() && document?.path === path && destination === originalPaths.get(targetKey);
      // An unchanged source path can still acquire a different meaning after route edits.
      if (
        resource.type === "WikiPage" &&
        target?.type === "WikiPage" &&
        target.spec.wiki === resource.spec.wiki
      ) {
        const wiki = desired.get(`Wiki/${resource.spec.wiki}`);
        if (wiki?.type === "Wiki") {
          const navigation = resolveWikiNavigation(wiki.spec.navigation ?? [], {
            sourceVersion: wiki.spec.sourceVersion,
          });
          const current = resolveWikiContentHref(saved.href, resource.name, navigation);
          unchangedContext =
            !shadowed() &&
            current?.page.page === identity.name &&
            current.search === identity.search &&
            current.hash === identity.hash;
          const page = navigation.pageByName.get(identity.name);
          if (page && !unchangedContext)
            href = `/${page.route.split("/").map(encodeURIComponent).join("/")}${suffix}`;
        }
      } else if (
        resource.type === "CoursePage" &&
        target?.type === "CoursePage" &&
        courseName(resource, desired) === courseName(target, desired)
      ) {
        const course = desired.get(`Course/${courseName(resource, desired)}`);
        const configPath = course && paths.get(`Course/${course.name}`);
        if (course?.type === "Course" && configPath) {
          const directory = posix.dirname(configPath);
          const navigation = resolveCourseNavigation(
            sourceCourseContext(
              [...desired.values()],
              course,
              paths,
              directory === "." ? "" : directory,
            ),
          );
          const current = resolveCourseContentHref(saved.href, resource.name, navigation);
          unchangedContext =
            !shadowed() &&
            current?.page.page === identity.name &&
            current.search === identity.search &&
            current.hash === identity.hash;
          const page = navigation.pageByName.get(identity.name);
          if (page && !unchangedContext)
            href = `/${page.route.split("/").map(encodeURIComponent).join("/")}${suffix}`;
        }
      } else if (!unchangedContext) {
        href = `${posix.relative(posix.dirname(path), destination).split("/").map(encodeURIComponent).join("/")}${suffix}`;
      }
      if (href !== saved.href)
        repairs.push({
          resource: key,
          kind: "reference",
          position: reference.position,
          before: saved.href,
          after: href,
          target: identity.name,
        });
      return href;
    },
    { allowCompiledAssetReferences: true },
  );
  if (!rewritten.ok)
    throw new SourcePlanningError({
      code: "reference-unrepresentable",
      message: "Source resource references cannot be written faithfully.",
      resource: key,
    });
  return { content: rewritten.content, repairs };
}

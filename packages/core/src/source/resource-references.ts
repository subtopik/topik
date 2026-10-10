import { posix } from "node:path";
import {
  parseTopikResourceReference,
  rewriteTopikNavigationReferences,
  serializeTopikResourceReference,
} from "@topik/content";
import type { Resource } from "../resource";
import { resolveWikiContentHref, resolveWikiNavigation } from "../wiki-navigation";
import { SourcePlanningError } from "./diagnostics";
import { withSourceScratch, type SourceDocumentProvenance, type SourceProject } from "./project";
import { compileResourceLinks } from "../compile/links";
import { validateTopikPath } from "../assets/path";

type ContentResource = Extract<Resource, { type: "WikiPage" | "Guide" | "CoursePage" }>;
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
): SourceDocumentProvenance | undefined {
  const supplied: SourceDocumentProvenance["references"][number][] = [];
  const rewritten = rewriteTopikNavigationReferences(
    resource.spec.content.value,
    (reference) => {
      if (
        parseTopikResourceReference(reference.href) ||
        reference.href.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(reference.href)
      )
        return undefined;
      const target =
        resolveSourcePathReference(
          reference.href,
          document?.path ?? path,
          directory,
          originalPaths,
          base,
        ) ??
        resolveSourcePathReference(
          reference.href,
          document?.path ?? path,
          directory,
          currentPaths,
          desired,
        );
      if (
        !target ||
        (resource.type === "WikiPage" &&
          target.type === "WikiPage" &&
          resource.spec.wiki === target.spec.wiki)
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
): Extract<Resource, { type: "WikiPage" | "Guide" }> | undefined {
  if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
    return undefined;
  try {
    const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    if (pathname.startsWith("/") && !/\.(?:mdx?|markdown)$/i.test(pathname)) return undefined;
    const resolved = validateTopikPath(
      pathname.startsWith("/")
        ? posix.join(directory, pathname.slice(1))
        : posix.join(posix.dirname(sourcePath), pathname || posix.basename(sourcePath)),
    );
    return resolved.ok
      ? findSourceReferenceTarget(resolved.value.path, paths, resources)
      : undefined;
  } catch {
    return undefined;
  }
}

function findSourceReferenceTarget(
  path: string,
  paths: ReadonlyMap<string, string>,
  resources: ReadonlyMap<string, Resource>,
): Extract<Resource, { type: "WikiPage" | "Guide" }> | undefined {
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
      (resource): resource is Extract<Resource, { type: "WikiPage" | "Guide" }> =>
        resource?.type === "WikiPage" || resource?.type === "Guide",
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
      let unchangedContext =
        document?.path === path && destination === originalPaths.get(targetKey);
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

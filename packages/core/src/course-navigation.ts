import { validateTopikPath, validateTopikPathSet } from "./assets/path";

const INTERNAL_COURSE_ORIGIN = "https://topik.invalid";
const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isName(value: string): boolean {
  return value.length <= 63 && RESOURCE_NAME.test(value);
}
function isSlug(value: string): boolean {
  return value.length <= 256 && RESOURCE_NAME.test(value);
}

/** @internal Logical page sources become Markdown files and must agree on directory spelling. */
export function validateCoursePageSources(paths: readonly string[]): boolean {
  if (!validateTopikPathSet(paths.map((path) => `${path}.md`)).ok) return false;
  const spellings = new Map<string, string>();
  for (const path of paths) {
    if (/\.(?:mdx?|markdown)$/i.test(path)) return false;
    const components = path.split("/");
    for (let length = 1; length <= components.length; length++) {
      const prefix = components.slice(0, length).join("/");
      const parsed = validateTopikPath(prefix);
      if (!parsed.ok) return false;
      const previous = spellings.get(parsed.value.collisionKey);
      if (previous !== undefined && previous !== prefix) return false;
      spellings.set(parsed.value.collisionKey, prefix);
    }
  }
  return true;
}

/** Portable reference context for one Course, independent of filesystem access. */
export type CourseReferenceContext = {
  course: string;
  modules: readonly { name: string; slug: string }[];
  pages: readonly { name: string; module: string; slug: string; sourcePath: string }[];
};

export type ResolvedCoursePage = {
  page: string;
  module: string;
  route: string;
  sourcePath: string;
};
export type ResolvedCourseNavigation = {
  course: string;
  pages: readonly ResolvedCoursePage[];
  pageByName: ReadonlyMap<string, ResolvedCoursePage>;
  pageByRoute: ReadonlyMap<string, ResolvedCoursePage>;
  pageBySourcePath: ReadonlyMap<string, ResolvedCoursePage>;
};
export type ResolvedCourseContentLink = {
  page: ResolvedCoursePage;
  route: string;
  hash: string;
  search: string;
};
export type ResolvedCourseContentReference =
  | { kind: "page"; target: ResolvedCourseContentLink }
  | { kind: "asset" }
  | { kind: "external" }
  | { kind: "unresolved" };

/** Public routes use module/page slugs; Markdown links use explicit logical source paths. */
export function resolveCourseNavigation(context: CourseReferenceContext): ResolvedCourseNavigation {
  const modules = new Map<string, string>();
  const moduleSlugs = new Set<string>();
  if (!isName(context.course))
    throw new Error("Course reference context requires a Course identity");
  if (!validateCoursePageSources(context.pages.map((page) => page.sourcePath)))
    throw new Error("Course reference context contains invalid source paths");
  for (const module of context.modules) {
    if (
      !isName(module.name) ||
      !isSlug(module.slug) ||
      modules.has(module.name) ||
      moduleSlugs.has(module.slug)
    )
      throw new Error("Course reference context contains duplicate or invalid modules");
    modules.set(module.name, module.slug);
    moduleSlugs.add(module.slug);
  }
  const pages: ResolvedCoursePage[] = [];
  const pageByName = new Map<string, ResolvedCoursePage>();
  const pageByRoute = new Map<string, ResolvedCoursePage>();
  const pageBySourcePath = new Map<string, ResolvedCoursePage>();
  for (const page of context.pages) {
    const moduleSlug = modules.get(page.module);
    if (!moduleSlug || !isName(page.name) || !isSlug(page.slug) || !page.sourcePath)
      throw new Error("Course page lacks a module, identity, route, or source path");
    const route = `${moduleSlug}/${page.slug}`;
    if (
      pageByName.has(page.name) ||
      pageByRoute.has(route) ||
      pageBySourcePath.has(page.sourcePath)
    )
      throw new Error("Course reference context contains duplicate pages, routes, or source paths");
    const resolved = { page: page.name, module: page.module, route, sourcePath: page.sourcePath };
    pages.push(resolved);
    pageByName.set(page.name, resolved);
    pageByRoute.set(route, resolved);
    pageBySourcePath.set(page.sourcePath, resolved);
  }
  return { course: context.course, pages, pageByName, pageByRoute, pageBySourcePath };
}

export function resolveCourseContentReference(
  href: string,
  currentPageName: string,
  resolved: ResolvedCourseNavigation,
): ResolvedCourseContentReference {
  if (/^asset:/i.test(href)) return { kind: "asset" };
  if (/^(?:https?|mailto|tel):/i.test(href)) return { kind: "external" };
  const target = resolveCourseContentHref(href, currentPageName, resolved);
  return target ? { kind: "page", target } : { kind: "unresolved" };
}

/** Resolve relative source references or root-relative public routes without guessing files. */
export function resolveCourseContentHref(
  href: string,
  currentPageName: string,
  resolved: ResolvedCourseNavigation,
): ResolvedCourseContentLink | null {
  const current = resolved.pageByName.get(currentPageName);
  if (!current || /^asset:/i.test(href)) return null;
  if (href.startsWith("#"))
    return { page: current, route: current.route, hash: href.slice(1), search: "" };
  let url: URL;
  try {
    const sourcePath = current.sourcePath.split("/").map(encodeURIComponent).join("/");
    url = new URL(href, `${INTERNAL_COURSE_ORIGIN}/${sourcePath}`);
  } catch {
    return null;
  }
  if (url.origin !== INTERNAL_COURSE_ORIGIN) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\.(?:mdx?|markdown)$/i, "");
  const sourceLink = !href.startsWith("/") || /\.(?:mdx?|markdown)$/i.test(path);
  const page = sourceLink
    ? resolved.pageBySourcePath.get(normalized)
    : resolved.pageByRoute.get(normalized);
  return page
    ? { page, route: page.route, hash: url.hash.replace(/^#/, ""), search: url.search }
    : null;
}

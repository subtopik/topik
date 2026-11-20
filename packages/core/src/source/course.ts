import { posix } from "node:path";
import { rewriteTopikNavigationReferences, type TopikNavigationReference } from "@topik/content";
import type { Course } from "@topik/schema/course/v1";
import type { CourseModule } from "@topik/schema/course-module/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import type { Resource } from "../resource";
import {
  resolveCourseNavigation,
  resolveCourseContentHref,
  resolveCourseContentReference,
  type CourseReferenceContext,
  type ResolvedCourseContentLink,
  type ResolvedCourseNavigation,
} from "../course-navigation";
import { failSourcePlan as fail } from "./diagnostics";
import { collectMetadataEdits } from "./metadata";
import { transportSavedReferences, type SourceDerivedRepair } from "./reference-transport";
import { patchSourceSequence, type SourceByteEdit } from "./syntax";
import { alignNavigation } from "./plan-navigation";

/** Items in the order a parent list names them; unlisted items follow in input order. */
function inListOrder<T extends { name: string }>(items: readonly T[], order: readonly string[]) {
  const listed = order
    .map((name) => items.find((item) => item.name === name))
    .filter((item): item is T => item !== undefined);
  return [...listed, ...items.filter((item) => !listed.includes(item))];
}

/** Course references keep stable identities independently of route and file placement. */
export function sourceCourseContext(
  resources: readonly Resource[],
  course: Course,
  paths: ReadonlyMap<string, string>,
  directory: string,
): CourseReferenceContext {
  const modules = inListOrder(
    resources.filter(
      (resource): resource is CourseModule =>
        resource.type === "CourseModule" && resource.spec.course === course.name,
    ),
    course.spec.modules,
  );
  return {
    course: course.name,
    modules: modules.map((module) => ({ name: module.name, slug: module.spec.slug })),
    pages: modules
      .flatMap((module) =>
        inListOrder(
          resources.filter(
            (resource): resource is CoursePage =>
              resource.type === "CoursePage" && resource.spec.module === module.name,
          ),
          module.spec.pages,
        ),
      )
      .map((page) => {
        const path = paths.get(`CoursePage/${page.name}`);
        if (!path || (directory && !path.startsWith(`${directory}/`)))
          fail(
            "source-mapping-missing",
            "Every Course page needs a source path inside its declared source.",
            `CoursePage/${page.name}`,
          );
        return {
          name: page.name,
          module: page.spec.module,
          slug: page.spec.slug,
          sourcePath: posix.relative(directory || ".", path).replace(/\.mdx?$/i, ""),
        };
      }),
  };
}

export function resolveSourceCourseContext(
  context: CourseReferenceContext,
  course: string,
  page: string,
): ResolvedCourseNavigation {
  if (context.course !== course)
    fail(
      "reference-context-invalid",
      "Saved reference context belongs to a different Course.",
      `CoursePage/${page}`,
    );
  let navigation: ResolvedCourseNavigation;
  try {
    navigation = resolveCourseNavigation(context);
  } catch {
    fail(
      "reference-context-invalid",
      "Saved Course reference context is invalid.",
      `CoursePage/${page}`,
    );
  }
  if (!navigation.pageByName.has(page))
    fail(
      "reference-context-invalid",
      "Saved reference context must contain the same page identity.",
      `CoursePage/${page}`,
    );
  return navigation;
}

/** Replace internal links with stable identity markers for semantic comparison. */
export function portableCoursePage(
  page: CoursePage,
  navigation: ResolvedCourseNavigation,
  isNonPageReference?: (reference: TopikNavigationReference) => boolean,
): CoursePage {
  const rewritten = rewriteTopikNavigationReferences(
    page.spec.content.value,
    (reference) => {
      if (isNonPageReference?.(reference)) return undefined;
      const { href } = reference;
      const target = resolveCourseContentHref(href, page.name, navigation);
      const prefix = "https://topik.invalid/reference/";
      return target
        ? `${prefix}course/${target.page.page}${target.search}${target.hash ? `#${target.hash}` : ""}`
        : href.startsWith(prefix)
          ? `${prefix}opaque/${encodeURIComponent(href)}`
          : undefined;
    },
    { allowCompiledAssetReferences: true },
  );
  if (!rewritten.ok)
    fail(
      "reference-context-invalid",
      "Saved Course reference meaning cannot be compared.",
      `CoursePage/${page.name}`,
    );
  return {
    ...page,
    spec: { ...page.spec, content: { ...page.spec.content, value: rewritten.content } },
  };
}

/** Transport saved Course references to the current navigation; true when content changed. */
export function transportCourseReferences(
  page: CoursePage,
  saved: ResolvedCourseNavigation,
  current: ResolvedCourseNavigation,
  repairs: SourceDerivedRepair[],
  resolveOtherReference?: (href: string) => string | undefined,
  isNonPageReference?: (reference: TopikNavigationReference) => boolean,
  isCurrentShadowed?: (
    reference: TopikNavigationReference,
    after: ResolvedCourseContentLink | null,
  ) => boolean,
): boolean {
  const key = `CoursePage/${page.name}`;
  const transported = transportSavedReferences({
    resource: key,
    content: page.spec.content.value,
    resolveSaved: (href) => resolveCourseContentReference(href, page.name, saved),
    resolveCurrent: (href) => resolveCourseContentHref(href, page.name, current),
    currentRoute: (name) => current.pageByName.get(name)?.route,
    repairs,
    resolveOtherReference,
    isNonPageReference,
    isCurrentShadowed,
    fail: (failure) => {
      switch (failure) {
        case "unresolved":
          return fail(
            "reference-target-unresolved",
            "An authored link has no target in its saved Course context.",
            key,
          );
        case "removed":
          return fail(
            "reference-target-removed",
            "An authored Course reference targets a removed page.",
            key,
          );
        case "unrepresentable":
          return fail(
            "reference-unrepresentable",
            "A Course source reference cannot preserve its target.",
            key,
          );
        case "rewrite":
          return fail(
            "reference-unrepresentable",
            "Course authoring references cannot be written faithfully.",
            key,
          );
      }
    },
  });
  if (!transported.changed) return false;
  page.spec.content.value = transported.content;
  return true;
}

/** Source module records in the order the Course lists them, each with its pages in order. */
export function sourceCourseModules(
  resources: readonly Resource[],
  course: Course,
  paths: ReadonlyMap<string, string>,
  directory: string,
): Array<Record<string, unknown> & { id: string; pages: string[] }> {
  const context = sourceCourseContext(resources, course, paths, directory);
  const modules = inListOrder(
    resources.filter(
      (resource): resource is CourseModule =>
        resource.type === "CourseModule" && resource.spec.course === course.name,
    ),
    course.spec.modules,
  );
  return modules.map((module) => ({
    id: module.name,
    title: module.spec.title,
    slug: module.spec.slug,
    ...(Object.hasOwn(module.spec, "description") ? { description: module.spec.description } : {}),
    ...(module.labels !== undefined ? { labels: module.labels } : {}),
    // The context already holds each module's pages in list order.
    pages: context.pages
      .filter((page) => page.module === module.name)
      .map((page) => page.sourcePath),
  }));
}

/**
 * Module facts and list order edit stable records, preserving unrelated source syntax. Lists
 * change as Wiki navigation does: removed entries are deleted in place, added entries are
 * appended, and an order that needs anything else rewrites that one list.
 */
export function planCourseConfiguration(input: {
  before: readonly Resource[];
  desired: readonly Resource[];
  course: Course;
  originalCourse: Course;
  paths: ReadonlyMap<string, string>;
  originalPaths: ReadonlyMap<string, string>;
  directory: string;
  raw: string;
  json: boolean;
}): { updates: Record<string, unknown>; edits: SourceByteEdit[]; membershipResources: string[] } {
  const pageNames = (context: CourseReferenceContext) =>
    new Map(context.pages.map((page) => [page.sourcePath, page.name]));
  const beforeNames = pageNames(
    sourceCourseContext(input.before, input.originalCourse, input.originalPaths, input.directory),
  );
  const afterNames = pageNames(
    sourceCourseContext(input.desired, input.course, input.paths, input.directory),
  );
  const before = sourceCourseModules(
    input.before,
    input.originalCourse,
    input.originalPaths,
    input.directory,
  );
  const after = sourceCourseModules(input.desired, input.course, input.paths, input.directory);
  const updates: Record<string, unknown> = {};
  const edits: SourceByteEdit[] = [];
  const membershipResources: string[] = [];
  const modules = alignNavigation(
    before.map((module) => module.id),
    after.map((module) => module.id),
  );
  if (!modules) {
    // The module order cannot be reached in place, so the list is written as one value.
    collectMetadataEdits(updates, "modules", before, after);
    membershipResources.push(...after.map((module) => `CourseModule/${module.id}`));
    return { updates, edits, membershipResources };
  }
  // Matched modules keep their entry: only changed fields and page lists are edited.
  for (const [index, nextIndex] of [...modules.anchors, ...modules.pairs]) {
    const module = before[index];
    const next = after[nextIndex];
    const selector = `modules/${encodeURIComponent(module.id)}`;
    if (module.id !== next.id) {
      // Another module takes this entry's place, so its record replaces the entry.
      updates[selector] = next;
      membershipResources.push(`CourseModule/${module.id}`, `CourseModule/${next.id}`);
      continue;
    }
    for (const field of ["title", "slug", "description", "labels"])
      collectMetadataEdits(updates, `${selector}/${field}`, module[field], next[field]);
    const previousPages = module.pages.map((path) => beforeNames.get(path));
    const nextPages = next.pages.map((path) => afterNames.get(path));
    const pages = alignNavigation(previousPages, nextPages);
    if (!pages) {
      updates[`${selector}/pages`] = next.pages;
      membershipResources.push(`CourseModule/${module.id}`);
      continue;
    }
    // A kept entry whose file moved, or whose place another page takes, changes only its path.
    let changed = false;
    for (const [pageIndex, nextPageIndex] of [...pages.anchors, ...pages.pairs]) {
      const path = module.pages[pageIndex];
      const replacement = next.pages[nextPageIndex];
      if (path === replacement) continue;
      updates[`${selector}/pages/${encodeURIComponent(path)}`] = replacement;
      changed = true;
    }
    if (pages.removals.length || pages.additions.length) {
      changed = true;
      edits.push(
        ...patchSourceSequence(
          input.raw,
          `${selector}/pages`,
          pages.additions.map((nextPageIndex) => next.pages[nextPageIndex]),
          pages.removals.map(
            (pageIndex) => `${selector}/pages/${encodeURIComponent(module.pages[pageIndex])}`,
          ),
          input.json,
        ),
      );
    }
    if (changed) membershipResources.push(`CourseModule/${module.id}`);
  }
  if (modules.removals.length || modules.additions.length)
    edits.push(
      ...patchSourceSequence(
        input.raw,
        "modules",
        modules.additions.map((index) => after[index]),
        modules.removals.map((index) => `modules/${encodeURIComponent(before[index].id)}`),
        input.json,
      ),
    );
  return { updates, edits, membershipResources };
}

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

/** Course references keep stable identities independently of route and file placement. */
export function sourceCourseContext(
  resources: readonly Resource[],
  course: Course,
  paths: ReadonlyMap<string, string>,
  directory: string,
): CourseReferenceContext {
  const modules = resources.filter(
    (resource): resource is CourseModule =>
      resource.type === "CourseModule" && resource.spec.course === course.name,
  );
  const members = new Set(modules.map((module) => module.name));
  return {
    course: course.name,
    modules: modules.map((module) => ({ name: module.name, slug: module.spec.slug })),
    pages: resources
      .filter(
        (resource): resource is CoursePage =>
          resource.type === "CoursePage" && members.has(resource.spec.module),
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

/** Array position is source syntax; explicit order values remain resource metadata. */
export function sourceCourseModules(
  resources: readonly Resource[],
  course: Course,
  paths: ReadonlyMap<string, string>,
  directory: string,
  preferred: readonly { id: string; pages: readonly string[] }[] = [],
  /** Page identity of each preferred source path, when the paths predate a move. */
  preferredPages?: ReadonlyMap<string, string>,
): Array<Record<string, unknown> & { id: string; pages: string[] }> {
  const context = sourceCourseContext(resources, course, paths, directory);
  const modules = resources.filter(
    (resource): resource is CourseModule =>
      resource.type === "CourseModule" && resource.spec.course === course.name,
  );
  const ordered = [
    ...preferred
      .map((item) => modules.find((module) => module.name === item.id))
      .filter((module): module is CourseModule => !!module),
    ...modules.filter((module) => !preferred.some((item) => item.id === module.name)),
  ];
  return ordered.map((module) => {
    const pages = context.pages.filter((page) => page.module === module.name);
    const previous = preferred.find((item) => item.id === module.name)?.pages ?? [];
    // Declaration position belongs to the page identity, so a moved file keeps its place.
    const retained = new Set(
      previous
        .map((path) =>
          preferredPages
            ? pages.find((page) => page.name === preferredPages.get(path))
            : pages.find((page) => page.sourcePath === path),
        )
        .filter((page) => page !== undefined),
    );
    const orderedPaths = [...retained, ...pages.filter((page) => !retained.has(page))].map(
      (page) => page.sourcePath,
    );
    return {
      id: module.name,
      title: module.spec.title,
      slug: module.spec.slug,
      order: module.spec.order,
      ...(Object.hasOwn(module.spec, "description")
        ? { description: module.spec.description }
        : {}),
      ...(module.labels !== undefined ? { labels: module.labels } : {}),
      pages: orderedPaths,
    };
  });
}

/** Module facts and memberships edit stable records, preserving unrelated source syntax. */
export function planCourseConfiguration(input: {
  before: readonly Resource[];
  desired: readonly Resource[];
  course: Course;
  originalCourse: Course;
  paths: ReadonlyMap<string, string>;
  originalPaths: ReadonlyMap<string, string>;
  directory: string;
  modules: readonly { id: string; pages: readonly string[] }[];
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
    input.modules,
  );
  const after = sourceCourseModules(
    input.desired,
    input.course,
    input.paths,
    input.directory,
    input.modules,
    beforeNames,
  );
  const updates: Record<string, unknown> = {};
  const edits: SourceByteEdit[] = [];
  const membershipResources: string[] = [];
  for (const module of before) {
    const next = after.find((candidate) => candidate.id === module.id);
    if (!next) continue;
    const selector = `modules/${encodeURIComponent(module.id)}`;
    for (const field of ["title", "slug", "order", "description", "labels"])
      collectMetadataEdits(updates, `${selector}/${field}`, module[field], next[field]);
    // A retained page whose file moved keeps its entry; only the path value changes.
    const nextPaths = new Map(next.pages.map((path) => [afterNames.get(path), path]));
    const previousNames = new Set(module.pages.map((path) => beforeNames.get(path)));
    let moved = false;
    for (const path of module.pages) {
      const replacement = nextPaths.get(beforeNames.get(path));
      if (replacement === undefined || replacement === path) continue;
      updates[`${selector}/pages/${encodeURIComponent(path)}`] = replacement;
      moved = true;
    }
    const removals = module.pages.filter((path) => !nextPaths.has(beforeNames.get(path)));
    const additions = next.pages.filter((path) => !previousNames.has(afterNames.get(path)));
    if (moved) membershipResources.push(`CourseModule/${module.id}`);
    if (removals.length || additions.length) {
      if (!moved) membershipResources.push(`CourseModule/${module.id}`);
      edits.push(
        ...patchSourceSequence(
          input.raw,
          `${selector}/pages`,
          additions,
          removals.map((path) => `${selector}/pages/${encodeURIComponent(path)}`),
          input.json,
        ),
      );
    }
  }
  const removed = before.filter((module) => !after.some((candidate) => candidate.id === module.id));
  const added = after.filter((module) => !before.some((candidate) => candidate.id === module.id));
  if (removed.length || added.length)
    edits.push(
      ...patchSourceSequence(
        input.raw,
        "modules",
        added,
        removed.map((module) => `modules/${encodeURIComponent(module.id)}`),
        input.json,
      ),
    );
  return { updates, edits, membershipResources };
}

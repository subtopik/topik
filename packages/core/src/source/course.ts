import { posix } from "node:path";
import { parseTopikResourceReference, rewriteTopikNavigationReferences } from "@topik/content";
import type { Course } from "@topik/schema/course/v1";
import type { CourseModule } from "@topik/schema/course-module/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import type { Resource } from "../resource";
import {
  resolveCourseNavigation,
  resolveCourseContentHref,
  resolveCourseContentReference,
  type CourseReferenceContext,
  type ResolvedCourseNavigation,
} from "../course-navigation";
import { SourcePlanningError } from "./diagnostics";
import { collectMetadataEdits } from "./metadata";
import { patchSourceSequence, type SourceByteEdit } from "./syntax";

function fail(code: string, message: string, resource?: string): never {
  throw new SourcePlanningError({ code, message, ...(resource ? { resource } : {}) });
}

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
): CoursePage {
  const rewritten = rewriteTopikNavigationReferences(
    page.spec.content.value,
    ({ href }) => {
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

export function transportCourseReferences(
  page: CoursePage,
  saved: ResolvedCourseNavigation,
  current: ResolvedCourseNavigation,
  repairs: Array<{
    resource: string;
    kind: "navigation" | "reference";
    position?: string;
    before?: string;
    after?: string;
    target?: string;
  }>,
  resolveOtherReference?: (href: string) => string | undefined,
): boolean {
  const key = `CoursePage/${page.name}`;
  const rewritten = rewriteTopikNavigationReferences(
    page.spec.content.value,
    (reference) => {
      if (parseTopikResourceReference(reference.href)) return undefined;
      const savedReference = resolveCourseContentReference(reference.href, page.name, saved);
      if (savedReference.kind === "unresolved") {
        const other = resolveOtherReference?.(reference.href);
        if (other !== undefined) return other;
      }
      if (savedReference.kind === "unresolved")
        fail(
          "reference-target-unresolved",
          "An authored link has no target in its saved Course context.",
          key,
        );
      if (savedReference.kind !== "page") return undefined;
      const before = savedReference.target;
      const after = resolveCourseContentHref(reference.href, page.name, current);
      if (
        after?.page.page === before.page.page &&
        after.search === before.search &&
        after.hash === before.hash
      )
        return undefined;
      const target = current.pageByName.get(before.page.page);
      if (!target)
        fail(
          "reference-target-removed",
          "An authored Course reference targets a removed page.",
          key,
        );
      const href = `/${target.route.split("/").map(encodeURIComponent).join("/")}${before.search}${before.hash ? `#${before.hash}` : ""}`;
      const proof = resolveCourseContentHref(href, page.name, current);
      if (
        proof?.page.page !== before.page.page ||
        proof.search !== before.search ||
        proof.hash !== before.hash
      )
        fail(
          "reference-unrepresentable",
          "A Course source reference cannot preserve its target.",
          key,
        );
      repairs.push({
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
    fail(
      "reference-unrepresentable",
      "Course authoring references cannot be written faithfully.",
      key,
    );
  if (!rewritten.changes.length) return false;
  page.spec.content.value = rewritten.content;
  return true;
}

/** Array position is source syntax; explicit order values remain resource metadata. */
export function sourceCourseModules(
  resources: readonly Resource[],
  course: Course,
  paths: ReadonlyMap<string, string>,
  directory: string,
  preferred: readonly { id: string; pages: readonly string[] }[] = [],
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
    const orderedPaths = [
      ...previous.filter((path) => pages.some((page) => page.sourcePath === path)),
      ...pages.map((page) => page.sourcePath).filter((path) => !previous.includes(path)),
    ];
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
    const removals = module.pages.filter((path) => !next.pages.includes(path));
    const additions = next.pages.filter((path) => !module.pages.includes(path));
    if (removals.length || additions.length) {
      membershipResources.push(`CourseModule/${module.id}`);
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

import type { Course } from "@topik/schema/course/v1";
import type { CourseModule } from "@topik/schema/course-module/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import { parseCourseConfig, parseCoursePageMetadata } from "../config/course";
import { resolveCourseNavigation, type CourseReferenceContext } from "../course-navigation";
import type { SourceResource } from "../resource";
import { compileAssetResourcesInSession, type AssetCompilationOptions } from "./assets";
import { createPortableReadSession, type PortableReadSession } from "../assets/files";
import { createContentMemo, type ContentMemo } from "./content-memo";
import {
  configurationDirectory,
  readExactConfigFile,
  readOptionalConfigFileWithPath,
  type LoadedConfig,
} from "./config";
import type { CompileResourceDiscovery } from "./guide";
import { existingDocuments, readMarkdownSource } from "./files";
import { PublicCompileError, publicSchemaError } from "./public-errors";
import {
  parseMarkdownFrontmatter,
  withFileLines,
  throwOnCompileErrors,
  type CompileResult,
  type CompileReadOptions,
  type CompileValidationOptions,
} from "./shared";
import { compileResourceLinksInSession, type CompileResourceReferenceTarget } from "./links";

export interface CompileCourseOptions extends CompileReadOptions {
  dir: string;
  /** Exact configuration path relative to dir; page sources are relative to its directory. */
  configFile?: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
  referenceTargets?: readonly CompileResourceReferenceTarget[];
}

export async function compileCourse(options: CompileCourseOptions): Promise<CompileResult> {
  const result = await inspectCourse(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectCourse(options: CompileCourseOptions): Promise<CompileResult> {
  const memo = createContentMemo();
  // One session shares Git repository evidence across every read of this call.
  const session = createPortableReadSession(options.fileSafety, options.gitExecutable);
  const discovered = await discoverCourse(options, undefined, memo, session);
  validateCourseAuthors(discovered.resources, discovered.sourcePathsByResource);
  const linked = await compileResourceLinksInSession(
    session,
    {
      rootDir: configurationDirectory(options.dir, options.configFile),
      resources: discovered.resources,
      sourcePathsByResource: discovered.sourcePathsByResource,
      bodyLinesByResource: discovered.bodyLinesByResource,
      validation: options.validation,
      referenceTargets: options.referenceTargets,
    },
    memo,
  );
  throwOnCompileErrors(linked.diagnostics);
  const compiled = await compileAssetResourcesInSession(
    session,
    {
      rootDir: configurationDirectory(options.dir, options.configFile),
      resources: linked.resources,
      sourcePathsByResource: discovered.sourcePathsByResource,
      protectedSourcePaths: discovered.consumedSourcePaths,
      ...options.assets,
    },
    memo,
  );
  return {
    diagnostics: [...discovered.diagnostics, ...linked.diagnostics],
    references: linked.references,
    ...compiled,
  };
}

/** @internal Source discovery shares the manifest's project-wide Asset and author pipeline. */
export async function discoverCourse(
  options: CompileCourseOptions,
  selectedConfig?: LoadedConfig,
  memo: ContentMemo = createContentMemo(),
  session: PortableReadSession = createPortableReadSession(
    options.fileSafety,
    options.gitExecutable,
  ),
): Promise<CompileResourceDiscovery> {
  const dir = configurationDirectory(options.dir, options.configFile);
  const loaded =
    selectedConfig ?? (await loadCourseConfig(options.dir, options.configFile, session));
  rejectCourseOrder(loaded.value, options.configFile ?? loaded.path);
  let config;
  try {
    config = parseCourseConfig(loaded.value);
  } catch (error) {
    throw publicSchemaError("config-invalid", options.configFile ?? loaded.path, error);
  }
  const course: Course = {
    apiVersion: "v1",
    type: "Course",
    name: config.id,
    ...(config.labels !== undefined ? { labels: config.labels } : {}),
    spec: {
      title: config.title,
      slug: config.slug,
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.authors !== undefined ? { authors: config.authors } : {}),
      modules: config.modules.map((module) => module.id),
    },
  };
  const resources: SourceResource[] = [course, ...(config.persons ?? [])];
  const diagnostics: CompileResult["diagnostics"] = [];
  const sourcePathsByResource: Record<string, string> = {};
  const bodyLinesByResource: Record<string, number> = {};
  const unvalidatedDocuments: NonNullable<CompileResourceDiscovery["unvalidatedDocuments"]> = [];
  const pagePathsByRoute = new Map<string, string>();
  const pages: CourseReferenceContext["pages"][number][] = [];
  for (const module of config.modules) {
    const resource: CourseModule = {
      apiVersion: "v1",
      type: "CourseModule",
      name: module.id,
      ...(module.labels !== undefined ? { labels: module.labels } : {}),
      spec: {
        course: config.id,
        title: module.title,
        slug: module.slug,
        pages: [],
        ...(module.description !== undefined ? { description: module.description } : {}),
      },
    };
    resources.push(resource);
    for (const sourcePath of module.pages) {
      const file = await readMarkdownSource(dir, sourcePath, {
        ambiguous: "course-page-ambiguous",
        notFound: "course-page-not-found",
      });
      const parsed = parseMarkdownFrontmatter(file.raw, file.path);
      if (isRecord(parsed.frontmatter) && Object.hasOwn(parsed.frontmatter, "order"))
        throw new PublicCompileError("course-order-removed", file.path, { field: "order" });
      let metadata;
      try {
        metadata = parseCoursePageMetadata(parsed.frontmatter);
      } catch (error) {
        throw publicSchemaError("frontmatter-invalid", file.path, error);
      }
      const key = `CoursePage/${metadata.id}`;
      if (Object.hasOwn(sourcePathsByResource, key))
        throw new PublicCompileError("frontmatter-invalid", file.path, {
          field: "id",
          relatedLocation: sourcePathsByResource[key],
        });
      const route = `${module.id}/${metadata.slug}`;
      const sameRoute = pagePathsByRoute.get(route);
      if (sameRoute !== undefined)
        throw new PublicCompileError("frontmatter-invalid", file.path, {
          field: "slug",
          relatedLocation: sameRoute,
        });
      const validation = memo.validate(parsed.content, file.path);
      diagnostics.push(...withFileLines(validation.diagnostics, parsed.bodyLineOffset));
      const page: CoursePage = {
        apiVersion: "v1",
        type: "CoursePage",
        name: metadata.id,
        ...(metadata.labels !== undefined ? { labels: metadata.labels } : {}),
        spec: {
          module: module.id,
          title: metadata.title,
          slug: metadata.slug,
          ...(metadata.description !== undefined ? { description: metadata.description } : {}),
          ...(metadata.authors !== undefined ? { authors: metadata.authors } : {}),
          content: { format: "topik", value: parsed.content },
        },
      };
      if (!validation.ok) {
        unvalidatedDocuments.push({ resource: page, sourcePath: file.path });
        continue;
      }
      resources.push(page);
      resource.spec.pages.push(page.name);
      sourcePathsByResource[key] = file.path;
      if (parsed.bodyLineOffset) bodyLinesByResource[key] = parsed.bodyLineOffset;
      pagePathsByRoute.set(route, file.path);
      pages.push({ name: page.name, module: module.id, slug: metadata.slug, sourcePath });
      const analysis = memo.analyze(parsed.content, file.path);
      diagnostics.push(...withFileLines(analysis.diagnostics, parsed.bodyLineOffset));
    }
  }
  const context: CourseReferenceContext = {
    course: config.id,
    modules: config.modules.map((module) => ({ name: module.id, slug: module.slug })),
    pages,
  };
  try {
    resolveCourseNavigation(context);
  } catch {
    throw new PublicCompileError("config-invalid", loaded.path);
  }
  return {
    resources,
    diagnostics,
    sourcePathsByResource,
    bodyLinesByResource,
    unvalidatedDocuments,
    consumedSourcePaths: [loaded.path],
    assetDirectory: config.assets.directory,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An `order` from a source written before list order is refused, never silently ignored. */
function rejectCourseOrder(raw: unknown, location: string): void {
  if (!isRecord(raw) || !Array.isArray(raw.modules)) return;
  for (const [index, module] of raw.modules.entries())
    if (isRecord(module) && Object.hasOwn(module, "order"))
      throw new PublicCompileError("course-order-removed", location, {
        field: `modules[${index}].order`,
      });
}

async function loadCourseConfig(
  dir: string,
  configFile: string | undefined,
  session: PortableReadSession,
): Promise<LoadedConfig> {
  if (configFile !== undefined) return readExactConfigFile(dir, configFile, session);
  const found = await readOptionalConfigFileWithPath(
    dir,
    ["course.yaml", "course.yml", "course.json"],
    session,
  );
  if (found === undefined) throw new PublicCompileError("config-not-found");
  return found;
}

/**
 * @internal The Markdown files a Course's modules name and that exist as regular files,
 * whether or not their content is valid. Reads no page content.
 */
export async function listCourseDocuments(dir: string, loaded: LoadedConfig): Promise<string[]> {
  let config;
  try {
    config = parseCourseConfig(loaded.value);
  } catch (error) {
    throw publicSchemaError("config-invalid", loaded.path, error);
  }
  return existingDocuments(
    dir,
    config.modules.flatMap((module) =>
      module.pages.flatMap((page) => [`${page}.md`, `${page}.mdx`]),
    ),
  );
}

export function validateCourseAuthors(
  resources: readonly SourceResource[],
  paths: Readonly<Record<string, string>>,
): void {
  const persons = new Set(
    resources.filter((resource) => resource.type === "Person").map((resource) => resource.name),
  );
  for (const resource of resources)
    if (
      (resource.type === "Course" || resource.type === "CoursePage") &&
      resource.spec.authors?.some((author) => !persons.has(author))
    )
      throw new PublicCompileError("author-not-found", paths[`${resource.type}/${resource.name}`]);
}

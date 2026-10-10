import { join, posix } from "node:path";
import {
  analyzeTopikContent,
  validateTopikAssetReference,
  validateTopikContent,
  topikLinkDiagnosticMessage,
  type AnalyzeTopikContentResult,
  type TopikContentDiagnostic,
} from "@topik/content";
import type { Course } from "@topik/schema/course/v1";
import type { CourseModule } from "@topik/schema/course-module/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import { parseCourseConfig, parseCoursePageMetadata } from "../config/course";
import {
  resolveCourseNavigation,
  resolveCourseContentReference,
  type CourseReferenceContext,
} from "../course-navigation";
import { readPortableAssetFile, classifyPortableNavigationPath } from "../assets/files";
import { validateTopikPath } from "../assets/path";
import type { SourceResource } from "../resource";
import { compileAssetResources, type AssetCompilationOptions } from "./assets";
import { configurationDirectory, readExactConfigFile, type LoadedConfig } from "./config";
import type { CompileResourceDiscovery } from "./guide";
import { readRegularFileWithinRoot } from "./files";
import { PublicCompileError } from "./public-errors";
import {
  hasCompileErrors,
  linkValidationPolicy,
  parseMarkdownFrontmatter,
  throwOnCompileErrors,
  type CompileResult,
  type CompileValidationOptions,
  type LinkValidationPolicy,
} from "./shared";

export interface CompileCourseOptions {
  dir: string;
  /** Exact configuration path relative to dir; page sources are relative to its directory. */
  configFile?: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
}

export async function compileCourse(options: CompileCourseOptions): Promise<CompileResult> {
  const result = await inspectCourse(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectCourse(options: CompileCourseOptions): Promise<CompileResult> {
  const discovered = await discoverCourse(options);
  validateCourseAuthors(discovered.resources, discovered.sourcePathsByResource);
  const compiled = await compileAssetResources({
    rootDir: configurationDirectory(options.dir, options.configFile),
    resources: discovered.resources,
    sourcePathsByResource: discovered.sourcePathsByResource,
    protectedSourcePaths: discovered.consumedSourcePaths,
    ...options.assets,
  });
  return { diagnostics: discovered.diagnostics, ...compiled };
}

/** @internal Source discovery shares the manifest's project-wide Asset and author pipeline. */
export async function discoverCourse(
  options: CompileCourseOptions,
  selectedConfig?: LoadedConfig,
): Promise<CompileResourceDiscovery> {
  const dir = configurationDirectory(options.dir, options.configFile);
  const loaded = selectedConfig ?? (await loadCourseConfig(options.dir, options.configFile));
  let config;
  try {
    config = parseCourseConfig(loaded.value);
  } catch {
    throw new PublicCompileError("config-invalid", options.configFile ?? loaded.path);
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
    },
  };
  const resources: SourceResource[] = [course, ...(config.persons ?? [])];
  const diagnostics: CompileResult["diagnostics"] = [];
  const sourcePathsByResource: Record<string, string> = {};
  const pages: CourseReferenceContext["pages"][number][] = [];
  const analyses = new Map<string, AnalyzeTopikContentResult>();
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
        order: module.order,
        ...(module.description !== undefined ? { description: module.description } : {}),
      },
    };
    resources.push(resource);
    for (const sourcePath of module.pages) {
      const file = await readCoursePage(dir, sourcePath);
      const parsed = parseMarkdownFrontmatter(file.raw, file.path, 1);
      let metadata;
      try {
        metadata = parseCoursePageMetadata(parsed.frontmatter);
      } catch {
        throw new PublicCompileError("frontmatter-invalid", file.path);
      }
      const key = `CoursePage/${metadata.id}`;
      if (Object.hasOwn(sourcePathsByResource, key))
        throw new PublicCompileError("config-invalid", loaded.path);
      const validation = validateTopikContent(parsed.content, { file: file.path });
      diagnostics.push(...validation.errors);
      if (!validation.valid) continue;
      const page: CoursePage = {
        apiVersion: "v1",
        type: "CoursePage",
        name: metadata.id,
        ...(metadata.labels !== undefined ? { labels: metadata.labels } : {}),
        spec: {
          module: module.id,
          title: metadata.title,
          slug: metadata.slug,
          order: metadata.order,
          ...(metadata.authors !== undefined ? { authors: metadata.authors } : {}),
          content: { format: "topik", value: parsed.content },
        },
      };
      resources.push(page);
      sourcePathsByResource[key] = file.path;
      pages.push({ name: page.name, module: module.id, slug: metadata.slug, sourcePath });
      const analysis = analyzeTopikContent(parsed.content, { file: file.path });
      diagnostics.push(...analysis.diagnostics);
      analyses.set(page.name, analysis);
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
  if (!hasCompileErrors(diagnostics))
    diagnostics.push(
      ...(await validateCourseLinks(
        dir,
        context,
        analyses,
        linkValidationPolicy(options.validation),
      )),
    );
  return {
    resources,
    diagnostics,
    sourcePathsByResource,
    consumedSourcePaths: [loaded.path],
    assetDirectory: config.assets.directory,
    sourceVersion: 1,
  };
}

async function loadCourseConfig(dir: string, configFile?: string): Promise<LoadedConfig> {
  if (configFile !== undefined) return readExactConfigFile(dir, configFile);
  for (const path of ["course.yaml", "course.yml", "course.json"]) {
    try {
      return await readExactConfigFile(dir, path);
    } catch (error) {
      if (!(error instanceof PublicCompileError) || error.id !== "config-not-found") throw error;
    }
  }
  throw new PublicCompileError("config-not-found");
}

async function readCoursePage(
  root: string,
  source: string,
): Promise<{ path: string; raw: string }> {
  let found: { path: string; raw: string } | undefined;
  for (const extension of [".md", ".mdx"]) {
    const path = `${source}${extension}`;
    let bytes: Buffer;
    try {
      bytes = await readRegularFileWithinRoot(join(root, path), root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (found) throw new PublicCompileError("course-page-ambiguous", path);
    try {
      found = { path, raw: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      throw new PublicCompileError("frontmatter-invalid", path);
    }
  }
  if (!found) throw new PublicCompileError("course-page-not-found", source);
  return found;
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

async function validateCourseLinks(
  root: string,
  context: CourseReferenceContext,
  analyses: ReadonlyMap<string, AnalyzeTopikContentResult>,
  policy: LinkValidationPolicy,
): Promise<TopikContentDiagnostic[]> {
  if (policy === "off") return [];
  const resolved = resolveCourseNavigation(context);
  const diagnostics: TopikContentDiagnostic[] = [];
  for (const page of resolved.pages)
    for (const link of analyses.get(page.page)?.links ?? []) {
      if (link.kind !== "link") continue;
      const reference = resolveCourseContentReference(link.href, page.page, resolved);
      if (reference.kind === "external" || reference.kind === "asset") continue;
      let id: "link-page-not-found" | "link-fragment-not-found" | undefined;
      if (reference.kind === "page") {
        let fragment = reference.target.hash;
        try {
          fragment = decodeURIComponent(fragment);
        } catch {
          /* The literal fragment remains unresolved. */
        }
        if (
          fragment &&
          !analyses
            .get(reference.target.page.page)
            ?.headings.some((heading) => heading.id === fragment)
        )
          id = "link-fragment-not-found";
      } else {
        if (!/\.(?:mdx?|markdown)(?:[?#]|$)/i.test(link.href)) {
          const asset = validateTopikAssetReference(link.href);
          if (asset.valid && asset.kind === "local") {
            const path = validateTopikPath(
              posix.join(posix.dirname(page.sourcePath), asset.decodedPath),
            );
            if (path.ok) {
              const kind = await classifyPortableNavigationPath({ root, path: path.value.path });
              const proof =
                kind === "directory"
                  ? undefined
                  : await readPortableAssetFile({ root, path: path.value.path });
              if (
                kind === "directory" ||
                proof?.ok ||
                proof?.diagnostics.some(
                  (diagnostic) => diagnostic.id !== "TOPIK_ASSET_FILE_MISSING",
                )
              )
                continue;
            }
          }
        }
        id = "link-page-not-found";
      }
      if (id)
        diagnostics.push({
          id,
          type: link.kind,
          level: policy === "error" ? "error" : "warning",
          message: topikLinkDiagnosticMessage(id)!,
          lines: link.lines,
          ...(link.file ? { file: link.file } : {}),
        });
    }
  return diagnostics;
}

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { analyzeTopikContent, validateTopikContent } from "@topik/content";
import type { Guide } from "@topik/schema/guide/v1";
import type { SourceResource } from "../resource";
import { parseCollectionConfig } from "../config/collection";
import { parseGuideMetadata } from "../config/source-version";
import { compileAssetResources, type AssetCompilationOptions } from "./assets";
import {
  readOptionalConfigFileWithPath,
  readExactConfigFile,
  configurationDirectory,
  type LoadedConfig,
} from "./config";
import {
  FileNotRegularError,
  FileOutsideCompilationRootError,
  readRegularFileWithinRoot,
} from "./files";
import { PublicCompileError } from "./public-errors";
import {
  extractMarkdownTitle,
  parseMarkdownFrontmatter,
  parseReferenceList,
  throwOnCompileErrors,
  type CompileValidationOptions,
  type CompileResult,
} from "./shared";
import { compileResourceLinks, type CompileResourceReferenceTarget } from "./links";

export interface CompileGuidesOptions {
  dir: string;
  /** Exact config path relative to dir; content is relative to the config directory. */
  configFile?: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
  referenceTargets?: readonly CompileResourceReferenceTarget[];
}

export interface CompileResourceDiscovery {
  sourceVersion?: 1;
  /** Destination relative to the selected configuration directory, if a config was loaded. */
  assetDirectory?: string;
  diagnostics: CompileResult["diagnostics"];
  resources: SourceResource[];
  sourcePathsByResource: Record<string, string>;
  consumedSourcePaths: string[];
}

export async function compileGuides(options: CompileGuidesOptions): Promise<CompileResult> {
  const result = await inspectGuides(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectGuides(options: CompileGuidesOptions): Promise<CompileResult> {
  const discovered = await discoverGuides(options);
  if (discovered.sourceVersion === 1)
    validateGuideAuthors(discovered.resources, discovered.sourcePathsByResource);
  const linked = await compileResourceLinks({
    rootDir: configurationDirectory(options.dir, options.configFile),
    resources: discovered.resources,
    sourcePathsByResource: discovered.sourcePathsByResource,
    validation: options.validation,
    referenceTargets: options.referenceTargets,
  });
  throwOnCompileErrors(linked.diagnostics);
  const compiled = await compileAssetResources({
    rootDir: configurationDirectory(options.dir, options.configFile),
    resources: linked.resources,
    sourcePathsByResource: discovered.sourcePathsByResource,
    protectedSourcePaths: discovered.consumedSourcePaths,
    ...options.assets,
  });
  return {
    diagnostics: [...discovered.diagnostics, ...linked.diagnostics],
    references: linked.references,
    ...compiled,
  };
}

/** @internal Discovery phase used by the mixed top-level compiler. */
export async function discoverGuides(
  options: CompileGuidesOptions,
  selectedConfig?: LoadedConfig,
): Promise<CompileResourceDiscovery> {
  const dir = configurationDirectory(options.dir, options.configFile);

  const loadedConfig =
    selectedConfig ??
    (options.configFile !== undefined
      ? await readExactConfigFile(options.dir, options.configFile)
      : await readOptionalConfigFileWithPath(dir, [
          "collection.yaml",
          "collection.yml",
          "collection.json",
        ]));
  if (loadedConfig == null) {
    return { diagnostics: [], resources: [], sourcePathsByResource: {}, consumedSourcePaths: [] };
  }

  let config;
  try {
    config = parseCollectionConfig(loadedConfig.value);
  } catch {
    throw new PublicCompileError("config-invalid", options.configFile ?? loadedConfig.path);
  }

  const files = await readdir(dir);
  const markdownFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx")).sort();

  const resources: SourceResource[] = [...(config.persons ?? [])];
  const diagnostics: CompileResult["diagnostics"] = [];
  const sourcePathsByResource: Record<string, string> = {};

  for (const file of markdownFiles) {
    const filePath = join(dir, file);
    let rawContent: string;
    try {
      rawContent = await readRegularFileWithinRoot(filePath, dir, "utf-8");
    } catch (error) {
      if (error instanceof FileOutsideCompilationRootError) {
        diagnostics.push({
          id: "guide-outside-compilation-root",
          type: "Guide",
          level: "error",
          message: "Guide files must resolve within the compilation directory",
          lines: [],
          file,
        });
        continue;
      }
      if (error instanceof FileNotRegularError) {
        diagnostics.push({
          id: "guide-not-regular-file",
          type: "Guide",
          level: "error",
          message: "Guide entries must be regular files",
          lines: [],
          file,
        });
        continue;
      }
      throw error;
    }
    const parsed = parseMarkdownFrontmatter(rawContent, file, config.sourceVersion);
    const { content } = parsed;
    let frontmatter = parsed.frontmatter;
    if (config.sourceVersion === 1) {
      try {
        frontmatter = parseGuideMetadata(frontmatter);
      } catch {
        throw new PublicCompileError("frontmatter-invalid", file);
      }
    }
    const validation = validateTopikContent(content, { file });
    diagnostics.push(...validation.errors);
    if (!validation.valid) continue;
    const slug =
      config.sourceVersion === 1 && typeof frontmatter.slug === "string"
        ? frontmatter.slug
        : fileToSlug(file);
    const name =
      config.sourceVersion === 1 && typeof frontmatter.id === "string"
        ? frontmatter.id
        : `${config.id}-${fileToSlug(file)}`;
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(content, slug);

    const tags =
      config.sourceVersion === 1 && frontmatter.inheritTags === false
        ? ((frontmatter.tags as string[] | undefined) ?? [])
        : mergeTags(config.tags, frontmatter.tags);
    const authors =
      config.sourceVersion === 1
        ? (frontmatter.authors as string[] | undefined)
        : parseReferenceList(frontmatter.authors, "authors", file);
    const description =
      typeof frontmatter.description === "string" ||
      (config.sourceVersion === 1 && frontmatter.description === null)
        ? frontmatter.description
        : undefined;
    const analysis = analyzeTopikContent(content, { file });
    diagnostics.push(...analysis.diagnostics);

    const guide: Guide = {
      apiVersion: "v1",
      type: "Guide",
      name,
      ...(config.sourceVersion === 1 && frontmatter.labels !== undefined
        ? { labels: frontmatter.labels as Record<string, string> }
        : {}),
      spec: {
        title,
        slug,
        ...(description !== undefined ? { description } : {}),
        ...(authors !== undefined ? { authors } : {}),
        ...(tags.length > 0 || (config.sourceVersion === 1 && frontmatter.tags !== undefined)
          ? { tags }
          : {}),
        content: {
          format: "topik",
          value: content,
        },
      },
    };

    resources.push(guide);
    sourcePathsByResource[`Guide/${guide.name}`] = file;
  }

  return {
    diagnostics,
    resources,
    sourcePathsByResource,
    consumedSourcePaths: [loadedConfig.path],
    assetDirectory: config.assets.directory,
    sourceVersion: config.sourceVersion,
  };
}

function fileToSlug(filename: string): string {
  return filename.replace(/\.(mdx?|md)$/, "");
}

export { extractMarkdownTitle as extractTitle } from "./shared";

export function validateGuideAuthors(
  resources: readonly SourceResource[],
  paths: Readonly<Record<string, string>>,
  guideNames?: ReadonlySet<string>,
): void {
  const persons = new Set(
    resources.filter((resource) => resource.type === "Person").map((resource) => resource.name),
  );
  for (const resource of resources)
    if (
      resource.type === "Guide" &&
      (!guideNames || guideNames.has(resource.name)) &&
      resource.spec.authors?.some((author) => !persons.has(author))
    )
      throw new PublicCompileError("author-not-found", paths[`Guide/${resource.name}`]);
}

function mergeTags(collectionTags: string[] | undefined, frontmatterTags: unknown): string[] {
  const tags = new Set<string>();
  if (collectionTags) {
    for (const tag of collectionTags) {
      tags.add(tag);
    }
  }
  if (Array.isArray(frontmatterTags)) {
    for (const tag of frontmatterTags) {
      if (typeof tag === "string") {
        tags.add(tag);
      }
    }
  }
  return [...tags];
}

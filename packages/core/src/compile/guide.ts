import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeTopikContent, validateTopikContent } from "@topik/content-schema";
import type { Guide } from "@topik/schema";
import type { Resource } from "../resource";
import { parseCollectionConfig } from "../config/collection";
import { compileAssetResources, type AssetCompilationOptions } from "./assets";
import { readOptionalConfigFileWithPath } from "./config";
import {
  FileNotRegularError,
  FileOutsideCompilationRootError,
  readRegularFileWithinRoot,
} from "./files";
import {
  extractMarkdownTitle,
  linkValidationPolicy,
  parseMarkdownFrontmatter,
  parseReferenceList,
  throwOnCompileErrors,
  type CompileValidationOptions,
  type CompileResult,
} from "./shared";
import { validateLocalFragments } from "./links";

export interface CompileGuidesOptions {
  dir: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
}

export interface CompileResourceDiscovery {
  diagnostics: CompileResult["diagnostics"];
  resources: Resource[];
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
  const compiled = await compileAssetResources({
    rootDir: resolve(options.dir),
    resources: discovered.resources,
    sourcePathsByResource: discovered.sourcePathsByResource,
    protectedSourcePaths: discovered.consumedSourcePaths,
    ...options.assets,
  });
  return { diagnostics: discovered.diagnostics, ...compiled };
}

/** @internal Discovery phase used by the mixed top-level compiler. */
export async function discoverGuides(
  options: CompileGuidesOptions,
): Promise<CompileResourceDiscovery> {
  const dir = resolve(options.dir);

  const loadedConfig = await readOptionalConfigFileWithPath(dir, [
    "collection.yaml",
    "collection.yml",
    "collection.json",
  ]);
  if (loadedConfig == null) {
    return { diagnostics: [], resources: [], sourcePathsByResource: {}, consumedSourcePaths: [] };
  }

  const config = parseCollectionConfig(loadedConfig.value);

  const files = await readdir(dir);
  const markdownFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx")).sort();

  const resources: Resource[] = [];
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
          file: filePath,
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
          file: filePath,
        });
        continue;
      }
      throw error;
    }
    const { frontmatter, content } = parseMarkdownFrontmatter(rawContent, file);
    const validation = validateTopikContent(content, { file: filePath });
    diagnostics.push(...validation.errors);
    if (!validation.valid) continue;
    const slug = fileToSlug(file);
    const name = `${config.id}-${slug}`;
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(content, slug);

    const tags = mergeTags(config.tags, frontmatter.tags);
    const authors = parseReferenceList(frontmatter.authors, "authors", file);
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description : undefined;
    const analysis = analyzeTopikContent(content, { file: filePath });
    diagnostics.push(...analysis.diagnostics);
    diagnostics.push(...validateLocalFragments(analysis, linkValidationPolicy(options.validation)));

    const guide: Guide = {
      apiVersion: "v1",
      type: "Guide",
      name,
      spec: {
        title,
        slug,
        ...(description != null ? { description } : {}),
        ...(authors != null ? { authors } : {}),
        ...(tags.length > 0 ? { tags } : {}),
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
  };
}

function fileToSlug(filename: string): string {
  return filename.replace(/\.(mdx?|md)$/, "");
}

export { extractMarkdownTitle as extractTitle } from "./shared";

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

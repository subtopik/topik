import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeTopikContent, validateTopikContent } from "@topik/content-schema";
import type { Guide } from "@topik/schema";
import type { Resource } from "../resource";
import { parseCollectionConfig } from "../config/collection";
import { extractAssets } from "./assets";
import { readOptionalConfigFile } from "./config";
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
}

export async function compileGuides(options: CompileGuidesOptions): Promise<CompileResult> {
  const result = await inspectGuides(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectGuides(options: CompileGuidesOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);

  const raw = await readOptionalConfigFile(dir, [
    "collection.yaml",
    "collection.yml",
    "collection.json",
  ]);
  if (raw == null) {
    return { diagnostics: [], resources: [] };
  }

  const config = parseCollectionConfig(raw);

  const files = await readdir(dir);
  const markdownFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx")).sort();

  const resources: Resource[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const assetsById = new Map<string, (typeof resources)[number]>();

  for (const file of markdownFiles) {
    const filePath = join(dir, file);
    const rawContent = await readFile(filePath, "utf-8");
    const { frontmatter, content } = parseMarkdownFrontmatter(rawContent, file);
    const validation = validateTopikContent(content, { file: filePath });
    diagnostics.push(...validation.errors);
    if (!validation.valid) continue;
    const {
      content: rewritten,
      assets,
      manifest,
    } = await extractAssets(content, {
      baseDir: dir,
      filePath,
    });
    for (const asset of assets) {
      if (!assetsById.has(asset.name)) {
        assetsById.set(asset.name, asset);
      }
    }

    const slug = fileToSlug(file);
    const name = `${config.id}-${slug}`;
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(rewritten, slug);

    const tags = mergeTags(config.tags, frontmatter.tags);
    const authors = parseReferenceList(frontmatter.authors, "authors", file);
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description : undefined;
    const analysis = analyzeTopikContent(rewritten, { file: filePath });
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
          value: rewritten,
        },
        ...(manifest.length > 0 ? { assets: manifest } : {}),
      },
    };

    resources.push(guide);
  }

  for (const asset of assetsById.values()) {
    resources.push(asset);
  }

  return { diagnostics, resources };
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

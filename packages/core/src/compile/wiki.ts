import { createHash } from "node:crypto";
import { join, posix, resolve } from "node:path";
import {
  analyzeTopikContent,
  validateTopikAssetReference,
  validateTopikContent,
  type TopikContentLink,
} from "@topik/content-schema";
import {
  joinWikiPath,
  type Wiki,
  type WikiDropdownNavNode,
  type WikiNavigation,
  type WikiNavNode as CompiledWikiNavNode,
  type WikiPage,
  type WikiSidebarNavNode,
} from "@topik/schema";
import type { SourceResource } from "../resource";
import { parseWikiConfig, WIKI_PAGE_NAME_HASH_LENGTH, type WikiNavNode } from "../config/wiki";
import { compileAssetResources, type AssetCompilationOptions } from "./assets";
import type { CompileResourceDiscovery } from "./guide";
import { readOptionalConfigFileWithPath } from "./config";
import { readRegularFileWithinRoot } from "./files";
import { PublicCompileError } from "./public-errors";
import { classifyPortableNavigationPath, readPortableAssetFile } from "../portable/files";
import { validateTopikPath } from "../portable/path";
import {
  extractMarkdownTitle,
  hasCompileErrors,
  linkValidationPolicy,
  parseMarkdownFrontmatter,
  throwOnCompileErrors,
  type CompileValidationOptions,
  type CompileResult,
} from "./shared";
import { validateWikiLinks, type WikiPageLinkAnalysis } from "./links";

export interface CompileWikiOptions {
  dir: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
}

export async function compileWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const result = await inspectWiki(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const discovered = await discoverWiki(options);
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
export async function discoverWiki(options: CompileWikiOptions): Promise<CompileResourceDiscovery> {
  const dir = resolve(options.dir);

  const loadedConfig = await readOptionalConfigFileWithPath(dir, [
    "wiki.yaml",
    "wiki.yml",
    "wiki.json",
  ]);
  if (loadedConfig == null) {
    return { diagnostics: [], resources: [], sourcePathsByResource: {}, consumedSourcePaths: [] };
  }

  let config;
  try {
    config = parseWikiConfig(loadedConfig.value);
  } catch {
    throw new PublicCompileError("config-invalid", loadedConfig.path);
  }
  const pagePaths = config.navigation ? [...new Set(collectPagePaths(config.navigation))] : [];
  const resolvedFiles = await Promise.all(pagePaths.map((pagePath) => readPageFile(dir, pagePath)));

  const resources: SourceResource[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const pageAnalyses: WikiPageLinkAnalysis[] = [];
  const sourcePathsByResource: Record<string, string> = {};

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const { filePath, raw } = resolvedFiles[i];
    const sourcePath = `${pagePath}${filePath.endsWith(".mdx") ? ".mdx" : ".md"}`;
    const { frontmatter, content } = parseMarkdownFrontmatter(raw, pagePath);
    const validation = validateTopikContent(content, { file: sourcePath });
    diagnostics.push(...validation.errors);
    if (!validation.valid) continue;
    const name = pagePathToName(config.id, pagePath);
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(content, pagePathToTitleFallback(pagePath));
    const description = normalizeWikiPageDescription(frontmatter.description);
    const analysis = analyzeTopikContent(content, { file: sourcePath });
    diagnostics.push(...analysis.diagnostics);
    pageAnalyses.push({ analysis, slug: pagePathToSlug(pagePath), sourcePath: pagePath });

    const pageResource: WikiPage = {
      apiVersion: "v1",
      type: "WikiPage",
      name,
      spec: {
        wiki: config.id,
        title,
        ...(description != null ? { description } : {}),
        content: {
          format: "topik",
          value: content,
        },
      },
    };

    resources.push(pageResource);
    sourcePathsByResource[`WikiPage/${pageResource.name}`] = sourcePath;
  }

  const wikiResource: Wiki = {
    apiVersion: "v1",
    type: "Wiki",
    name: config.id,
    spec: {
      title: config.title,
      ...(config.description != null ? { description: config.description } : {}),
      ...(config.navigation
        ? { navigation: resolveNavigation(config.navigation, config.id) as WikiNavigation }
        : {}),
      ...(config.theme ? { theme: config.theme } : {}),
    },
  };

  resources.push(wikiResource);

  if (!hasCompileErrors(diagnostics)) {
    const nonPageLinks = await classifyWikiNonPageLinks(dir, pageAnalyses);
    diagnostics.push(
      ...validateWikiLinks(pageAnalyses, linkValidationPolicy(options.validation), nonPageLinks),
    );
  }

  return {
    diagnostics,
    resources,
    sourcePathsByResource,
    consumedSourcePaths: [loadedConfig.path],
  };
}

async function classifyWikiNonPageLinks(
  root: string,
  pages: readonly WikiPageLinkAnalysis[],
): Promise<ReadonlySet<TopikContentLink>> {
  const nonPageLinks = new Set<TopikContentLink>();
  const existingByPath = new Map<string, boolean>();
  for (const page of pages) {
    for (const link of page.analysis.links) {
      if (link.kind !== "link") continue;
      const reference = validateTopikAssetReference(link.href);
      if (!reference.valid || reference.kind !== "local") continue;
      const path = validateTopikPath(
        posix.join(posix.dirname(page.sourcePath), reference.decodedPath),
      );
      if (!path.ok) continue;

      let existing = existingByPath.get(path.value.path);
      if (existing === undefined) {
        const kind = await classifyPortableNavigationPath({ root, path: path.value.path });
        if (kind === "directory") {
          existing = true;
        } else {
          const proof = await readPortableAssetFile({ root, path: path.value.path });
          existing =
            proof.ok ||
            proof.diagnostics.some((diagnostic) => diagnostic.id !== "TOPIK_ASSET_FILE_MISSING");
        }
        existingByPath.set(path.value.path, existing);
      }
      if (existing) nonPageLinks.add(link);
    }
  }
  return nonPageLinks;
}

// Keep compiled WikiPage spec.description within wikiPageSchema's 1024-character limit.
function normalizeWikiPageDescription(description: unknown): string | undefined {
  return typeof description === "string" ? description.slice(0, 1024) : undefined;
}

function collectPagePaths(nodes: WikiNavNode[], prefix = ""): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (typeof node === "string" || node.type === "page") {
      paths.push(joinWikiPath(prefix, typeof node === "string" ? node : node.slug));
    } else if ("children" in node) {
      paths.push(...collectPagePaths(node.children, joinWikiPath(prefix, node.slug)));
    }
  }
  return paths;
}

async function readPageFile(
  dir: string,
  pagePath: string,
): Promise<{ filePath: string; raw: string }> {
  for (const ext of [".mdx", ".md"]) {
    const filePath = join(dir, pagePath + ext);
    try {
      const raw = await readRegularFileWithinRoot(filePath, dir, "utf-8");
      return { filePath, raw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  throw new PublicCompileError("wiki-page-not-found");
}

function pagePathToSlug(pagePath: string): string {
  if (pagePath === "index") return "";
  return pagePath.replace(/\/index$/, "");
}

export function pagePathToName(wikiId: string, pagePath: string): string {
  const normalizedPath = normalizePagePath(pagePath);
  const pathHash = createHash("sha256")
    .update(normalizedPath)
    .digest("hex")
    .slice(0, WIKI_PAGE_NAME_HASH_LENGTH);
  return `${wikiId}-${pathHash}`;
}

function resolveNavigation(
  nodes: WikiNavNode[],
  wikiId: string,
  prefix = "",
): CompiledWikiNavNode[] {
  return nodes.map((node) => {
    if (typeof node === "string" || node.type === "page") {
      const localPath = typeof node === "string" ? node : node.slug;
      const pagePath = joinWikiPath(prefix, localPath);
      const pageName = pagePathToName(wikiId, pagePath);
      return {
        type: "page",
        page: pageName,
        slug: pagePathToSlug(localPath),
        sourcePath: pagePath,
        ...(typeof node !== "string" && node.icon ? { icon: node.icon } : {}),
        ...(typeof node !== "string" && node.hidden ? { hidden: true } : {}),
      };
    }

    if ("children" in node) {
      const children = resolveNavigation(node.children, wikiId, joinWikiPath(prefix, node.slug));
      if (node.type === "group") {
        return {
          type: "group",
          title: node.title,
          ...(node.slug ? { slug: node.slug } : {}),
          ...(node.icon ? { icon: node.icon } : {}),
          ...(node.hidden ? { hidden: true } : {}),
          ...(node.expanded ? { expanded: true } : {}),
          children: children as WikiSidebarNavNode[],
        };
      }
      if (node.type === "tab") {
        return {
          type: "tab",
          title: node.title,
          ...(node.slug ? { slug: node.slug } : {}),
          ...(node.icon ? { icon: node.icon } : {}),
          ...(node.hidden ? { hidden: true } : {}),
          children: children as WikiDropdownNavNode[] | WikiSidebarNavNode[],
        };
      }
      return {
        type: "dropdown",
        title: node.title,
        ...(node.slug ? { slug: node.slug } : {}),
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.hidden ? { hidden: true } : {}),
        children: children as WikiSidebarNavNode[],
      };
    }

    if (node.type === "tab") {
      return {
        type: "tab",
        title: node.title,
        href: node.href,
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.hidden ? { hidden: true } : {}),
      };
    }
    if (node.type === "dropdown") {
      return {
        type: "dropdown",
        title: node.title,
        href: node.href,
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.hidden ? { hidden: true } : {}),
      };
    }
    return {
      type: "link",
      title: node.title,
      href: node.href,
      ...(node.icon ? { icon: node.icon } : {}),
      ...(node.hidden ? { hidden: true } : {}),
    };
  });
}

function normalizePagePath(pagePath: string): string {
  return pagePath.replace(/^\//, "").replace(/\.(?:mdx?|markdown)$/i, "");
}

function pagePathToTitleFallback(pagePath: string): string {
  return normalizePagePath(pagePath).replaceAll("/", "-");
}
export { extractMarkdownTitle as extractTitle } from "./shared";

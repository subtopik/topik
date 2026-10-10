import { createHash } from "node:crypto";
import { join } from "node:path";
import { analyzeTopikContent, validateTopikContent } from "@topik/content";
import type {
  Wiki,
  WikiDropdownNavNode,
  WikiNavigation,
  WikiNavNode as CompiledWikiNavNode,
  WikiSidebarNavNode,
} from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { SourceResource } from "../resource";
import { parseWikiConfig, WIKI_PAGE_NAME_HASH_LENGTH, type WikiNavNode } from "../config/wiki";
import { parsePageMetadata } from "../config/source-version";
import { compileAssetResources, type AssetCompilationOptions } from "./assets";
import type { CompileResourceDiscovery } from "./guide";
import {
  readOptionalConfigFileWithPath,
  readExactConfigFile,
  configurationDirectory,
  type LoadedConfig,
} from "./config";
import { readRegularFileWithinRoot } from "./files";
import { PublicCompileError } from "./public-errors";
import {
  extractMarkdownTitle,
  parseMarkdownFrontmatter,
  throwOnCompileErrors,
  type CompileValidationOptions,
  type CompileResult,
} from "./shared";
import { compileResourceLinks, type CompileResourceReferenceTarget } from "./links";
import { joinWikiPath } from "../wiki-navigation";

export interface CompileWikiOptions {
  dir: string;
  /** Exact config path relative to dir; content is relative to the config directory. */
  configFile?: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
  referenceTargets?: readonly CompileResourceReferenceTarget[];
}

export async function compileWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const result = await inspectWiki(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const discovered = await discoverWiki(options);
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
export async function discoverWiki(
  options: CompileWikiOptions,
  selectedConfig?: LoadedConfig,
): Promise<CompileResourceDiscovery> {
  const dir = configurationDirectory(options.dir, options.configFile);

  const loadedConfig =
    selectedConfig ??
    (options.configFile !== undefined
      ? await readExactConfigFile(options.dir, options.configFile)
      : await readOptionalConfigFileWithPath(dir, ["wiki.yaml", "wiki.yml", "wiki.json"]));
  if (loadedConfig == null) {
    return { diagnostics: [], resources: [], sourcePathsByResource: {}, consumedSourcePaths: [] };
  }

  let config;
  try {
    config = parseWikiConfig(loadedConfig.value);
  } catch {
    throw new PublicCompileError("config-invalid", options.configFile ?? loadedConfig.path);
  }
  const pages = config.navigation ? collectPages(config.navigation) : [];
  const pagePaths = [...new Set(pages.map((page) => page.sourcePath))];
  if (config.sourceVersion === 1 && pagePaths.length !== pages.length)
    throw new PublicCompileError("config-invalid", loadedConfig.path);
  const resolvedFiles = await Promise.all(
    pagePaths.map((pagePath) => readPageFile(dir, pagePath, config.sourceVersion === 1)),
  );

  const resources: SourceResource[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const sourcePathsByResource: Record<string, string> = {};
  const pageNamesBySource = new Map<string, string>();

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const { filePath, raw } = resolvedFiles[i];
    const sourcePath = `${pagePath}${filePath.endsWith(".mdx") ? ".mdx" : ".md"}`;
    const parsed = parseMarkdownFrontmatter(raw, pagePath, config.sourceVersion);
    const { content } = parsed;
    let frontmatter = parsed.frontmatter;
    if (config.sourceVersion === 1) {
      try {
        frontmatter = parsePageMetadata(frontmatter);
      } catch {
        throw new PublicCompileError("frontmatter-invalid", sourcePath);
      }
    }
    const validation = validateTopikContent(content, { file: sourcePath });
    diagnostics.push(...validation.errors);
    if (!validation.valid) continue;
    const name =
      config.sourceVersion === 1 && typeof frontmatter.id === "string"
        ? frontmatter.id
        : pagePathToName(config.id, pagePath);
    if (pageNamesBySource.has(pagePath) || Object.hasOwn(sourcePathsByResource, `WikiPage/${name}`))
      throw new PublicCompileError("config-invalid", loadedConfig.path);
    pageNamesBySource.set(pagePath, name);
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(content, pagePathToTitleFallback(pagePath));
    const description =
      config.sourceVersion === 1
        ? (frontmatter.description as string | null | undefined)
        : normalizeWikiPageDescription(frontmatter.description);
    const analysis = analyzeTopikContent(content, { file: sourcePath });
    diagnostics.push(...analysis.diagnostics);

    const pageResource: WikiPage = {
      apiVersion: "v1",
      type: "WikiPage",
      name,
      ...(config.sourceVersion === 1 && frontmatter.labels !== undefined
        ? { labels: frontmatter.labels as Record<string, string> }
        : {}),
      spec: {
        wiki: config.id,
        title,
        ...(description !== undefined ? { description } : {}),
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
    ...(config.labels !== undefined ? { labels: config.labels } : {}),
    spec: {
      ...(config.sourceVersion === 1 ? { sourceVersion: 1 } : {}),
      title: config.title,
      ...(config.description !== undefined &&
      (config.sourceVersion === 1 || config.description !== null)
        ? { description: config.description }
        : {}),
      ...(config.navigation
        ? {
            navigation: resolveNavigation(
              config.navigation,
              config.id,
              "",
              pageNamesBySource,
              config.sourceVersion,
            ) as WikiNavigation,
          }
        : {}),
      ...(config.theme ? { theme: config.theme } : {}),
    },
  };

  resources.push(wikiResource);

  return {
    diagnostics,
    resources,
    sourcePathsByResource,
    consumedSourcePaths: [loadedConfig.path],
    assetDirectory: config.assets.directory,
    sourceVersion: config.sourceVersion,
  };
}

// Keep compiled WikiPage spec.description within the WikiPage/v1 schema's 1024-character limit.
function normalizeWikiPageDescription(description: unknown): string | undefined {
  return typeof description === "string" ? description.slice(0, 1024) : undefined;
}

function collectPages(nodes: WikiNavNode[], prefix = ""): { sourcePath: string; route: string }[] {
  const paths: { sourcePath: string; route: string }[] = [];
  for (const node of nodes) {
    if (typeof node === "string" || node.type === "page") {
      const routePath = joinWikiPath(prefix, typeof node === "string" ? node : node.slug);
      paths.push({
        sourcePath: typeof node !== "string" && node.source !== undefined ? node.source : routePath,
        route: pagePathToSlug(routePath),
      });
    } else if ("children" in node) {
      paths.push(...collectPages(node.children, joinWikiPath(prefix, node.slug)));
    }
  }
  return paths;
}

async function readPageFile(
  dir: string,
  pagePath: string,
  requireUnique = false,
): Promise<{ filePath: string; raw: string }> {
  let found: { filePath: string; raw: string } | undefined;
  for (const ext of [".mdx", ".md"]) {
    const filePath = join(dir, pagePath + ext);
    try {
      const raw = await readRegularFileWithinRoot(filePath, dir, "utf-8");
      if (!requireUnique) return { filePath, raw };
      if (found) throw new PublicCompileError("wiki-page-ambiguous");
      found = { filePath, raw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  if (found) return found;
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
  pageNamesBySource = new Map<string, string>(),
  sourceVersion?: 1,
): CompiledWikiNavNode[] {
  return nodes.map((node) => {
    if (typeof node === "string" || node.type === "page") {
      const localPath = typeof node === "string" ? node : node.slug;
      const pagePath =
        typeof node !== "string" && node.source !== undefined
          ? node.source
          : joinWikiPath(prefix, localPath);
      const pageName = pageNamesBySource.get(pagePath) ?? pagePathToName(wikiId, pagePath);
      return {
        type: "page",
        page: pageName,
        slug: pagePathToSlug(localPath),
        sourcePath: pagePath,
        ...(typeof node !== "string" && node.icon ? { icon: node.icon } : {}),
        ...(typeof node !== "string" &&
        node.hidden !== undefined &&
        (sourceVersion === 1 || node.hidden)
          ? { hidden: node.hidden }
          : {}),
      };
    }

    if ("children" in node) {
      const children = resolveNavigation(
        node.children,
        wikiId,
        joinWikiPath(prefix, node.slug),
        pageNamesBySource,
        sourceVersion,
      );
      if (node.type === "group") {
        return {
          type: "group",
          title: node.title,
          ...(node.slug ? { slug: node.slug } : {}),
          ...(node.icon ? { icon: node.icon } : {}),
          ...(node.hidden !== undefined && (sourceVersion === 1 || node.hidden)
            ? { hidden: node.hidden }
            : {}),
          ...(node.expanded !== undefined && (sourceVersion === 1 || node.expanded)
            ? { expanded: node.expanded }
            : {}),
          children: children as WikiSidebarNavNode[],
        };
      }
      if (node.type === "tab") {
        return {
          type: "tab",
          title: node.title,
          ...(node.slug ? { slug: node.slug } : {}),
          ...(node.icon ? { icon: node.icon } : {}),
          ...(node.hidden !== undefined && (sourceVersion === 1 || node.hidden)
            ? { hidden: node.hidden }
            : {}),
          children: children as WikiDropdownNavNode[] | WikiSidebarNavNode[],
        };
      }
      return {
        type: "dropdown",
        title: node.title,
        ...(node.slug ? { slug: node.slug } : {}),
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.hidden !== undefined && (sourceVersion === 1 || node.hidden)
          ? { hidden: node.hidden }
          : {}),
        children: children as WikiSidebarNavNode[],
      };
    }

    if (node.type === "tab") {
      return {
        type: "tab",
        title: node.title,
        href: node.href,
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.hidden !== undefined && (sourceVersion === 1 || node.hidden)
          ? { hidden: node.hidden }
          : {}),
      };
    }
    if (node.type === "dropdown") {
      return {
        type: "dropdown",
        title: node.title,
        href: node.href,
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.hidden !== undefined && (sourceVersion === 1 || node.hidden)
          ? { hidden: node.hidden }
          : {}),
      };
    }
    return {
      type: "link",
      title: node.title,
      href: node.href,
      ...(node.icon ? { icon: node.icon } : {}),
      ...(node.hidden !== undefined && (sourceVersion === 1 || node.hidden)
        ? { hidden: node.hidden }
        : {}),
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

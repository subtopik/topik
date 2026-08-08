import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { analyzeTopikContent, validateTopikContent } from "@topik/content-schema";
import {
  joinWikiPath,
  type Wiki,
  type WikiDropdownNavNode,
  type WikiNavigation,
  type WikiNavNode as CompiledWikiNavNode,
  type WikiPage,
  type WikiSidebarNavNode,
} from "@topik/schema";
import type { Resource } from "../resource";
import { parseWikiConfig, WIKI_PAGE_NAME_HASH_LENGTH, type WikiNavNode } from "../config/wiki";
import {
  compilePortableResourceArtifacts,
  TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
  type PortableAssetCompilationOptions,
} from "./assets";
import { readOptionalConfigFile } from "./config";
import { readRegularFileWithinRoot } from "./files";
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
  assets?: PortableAssetCompilationOptions;
}

export async function compileWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const result = await inspectWiki(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);

  const raw = await readOptionalConfigFile(dir, ["wiki.yaml", "wiki.yml", "wiki.json"]);
  if (raw == null) {
    return {
      diagnostics: [],
      resources: [],
      artifacts: [],
      assetKeyState: options.assets?.keyState ?? {
        version: TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
        keysByResource: {},
        retiredKeys: [],
      },
    };
  }

  const config = parseWikiConfig(raw);
  const pagePaths = config.navigation ? [...new Set(collectPagePaths(config.navigation))] : [];
  const resolvedFiles = await Promise.all(pagePaths.map((pagePath) => readPageFile(dir, pagePath)));

  const resources: Resource[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const pageAnalyses: WikiPageLinkAnalysis[] = [];
  const sourcePathsByResource: Record<string, string> = {};

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const { filePath, raw } = resolvedFiles[i];
    const { frontmatter, content } = parseMarkdownFrontmatter(raw, pagePath);
    const validation = validateTopikContent(content, { file: filePath });
    diagnostics.push(...validation.errors);
    if (!validation.valid) continue;
    const name = pagePathToName(config.id, pagePath);
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(content, pagePathToTitleFallback(pagePath));
    const description = normalizeWikiPageDescription(frontmatter.description);
    const analysis = analyzeTopikContent(content, { file: filePath });
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
    sourcePathsByResource[`WikiPage/${pageResource.name}`] =
      `${pagePath}${filePath.endsWith(".mdx") ? ".mdx" : ".md"}`;
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
    diagnostics.push(...validateWikiLinks(pageAnalyses, linkValidationPolicy(options.validation)));
  }

  const compiled = await compilePortableResourceArtifacts({
    rootDir: dir,
    resources,
    sourcePathsByResource,
    downloadableLinkPositionsByResource: options.assets?.downloadableLinkPositionsByResource,
    keyState: options.assets?.keyState,
    randomBytes: options.assets?.randomBytes,
  });
  return {
    diagnostics,
    resources: compiled.resources,
    artifacts: compiled.artifacts,
    assetKeyState: compiled.keyState,
  };
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
  throw new Error(`Page not found: ${pagePath} (tried .md and .mdx in ${dir})`);
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

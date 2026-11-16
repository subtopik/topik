import { createHash } from "node:crypto";
import { join } from "node:path";
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
import { validateResources } from "../validate";
import { compileAssetResourcesInSession, type AssetCompilationOptions } from "./assets";
import { createPortableReadSession } from "../assets/files";
import { createContentMemo, type ContentMemo } from "./content-memo";
import type { CompileResourceDiscovery } from "./guide";
import {
  readOptionalConfigFileWithPath,
  readExactConfigFile,
  configurationDirectory,
  type LoadedConfig,
} from "./config";
import { decodeUtf8Document, mapWithConcurrency, readRegularFileWithinRoot } from "./files";
import { PublicCompileError, publicSchemaError } from "./public-errors";
import {
  extractMarkdownTitle,
  parseMarkdownFrontmatter,
  throwOnCompileErrors,
  type CompileValidationOptions,
  type CompileResult,
} from "./shared";
import { compileResourceLinksInSession, type CompileResourceReferenceTarget } from "./links";
import { joinWikiPath } from "../wiki-navigation";

export interface CompileWikiOptions {
  dir: string;
  /** Exact config path relative to dir; content is relative to the config directory. */
  configFile?: string;
  validation?: CompileValidationOptions;
  assets?: AssetCompilationOptions;
  referenceTargets?: readonly CompileResourceReferenceTarget[];
}

/** Bounds open page descriptors; results keep declaration order. */
const PAGE_READ_CONCURRENCY = 16;

export async function compileWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const result = await inspectWiki(options);
  throwOnCompileErrors(result.diagnostics);
  return result;
}

export async function inspectWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const memo = createContentMemo();
  const discovered = await discoverWiki(options, undefined, memo);
  const linked = await compileResourceLinksInSession(
    createPortableReadSession(),
    {
      rootDir: configurationDirectory(options.dir, options.configFile),
      resources: discovered.resources,
      sourcePathsByResource: discovered.sourcePathsByResource,
      validation: options.validation,
      referenceTargets: options.referenceTargets,
    },
    memo,
  );
  throwOnCompileErrors(linked.diagnostics);
  const compiled = await compileAssetResourcesInSession(
    createPortableReadSession(),
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
    courseNavigation: {},
    ...compiled,
  };
}

/** @internal Discovery phase used by the mixed top-level compiler. */
export async function discoverWiki(
  options: CompileWikiOptions,
  selectedConfig?: LoadedConfig,
  memo: ContentMemo = createContentMemo(),
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
  } catch (error) {
    throw publicSchemaError("config-invalid", options.configFile ?? loadedConfig.path, error);
  }
  const pages = config.navigation ? collectPages(config.navigation) : [];
  const pagePaths = [...new Set(pages.map((page) => page.sourcePath))];
  if (config.sourceVersion === 1 && pagePaths.length !== pages.length)
    throw new PublicCompileError("config-invalid", loadedConfig.path);
  const resolvedFiles = await mapWithConcurrency(pagePaths, PAGE_READ_CONCURRENCY, (pagePath) =>
    readPageFile(dir, pagePath, config.sourceVersion === 1),
  );

  const resources: SourceResource[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const sourcePathsByResource: Record<string, string> = {};
  const pageNamesBySource = new Map<string, string>();

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const { filePath, raw } = resolvedFiles[i];
    const sourcePath = `${pagePath}${filePath.endsWith(".mdx") ? ".mdx" : ".md"}`;
    const parsed = parseMarkdownFrontmatter(raw, sourcePath, config.sourceVersion);
    const { content } = parsed;
    let frontmatter = parsed.frontmatter;
    if (config.sourceVersion === 1) {
      try {
        frontmatter = parsePageMetadata(frontmatter);
      } catch (error) {
        throw publicSchemaError("frontmatter-invalid", sourcePath, error);
      }
    }
    const validation = memo.validate(content, sourcePath);
    diagnostics.push(...validation.errors);
    if (!validation.valid) continue;
    const name =
      config.sourceVersion === 1 && typeof frontmatter.id === "string"
        ? frontmatter.id
        : pagePathToName(config.id, pagePath);
    if (pageNamesBySource.has(pagePath) || Object.hasOwn(sourcePathsByResource, `WikiPage/${name}`))
      throw new PublicCompileError("config-invalid", loadedConfig.path);
    pageNamesBySource.set(pagePath, name);
    const analysis = memo.analyze(content, sourcePath);
    diagnostics.push(...analysis.diagnostics);
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(content, pagePathToTitleFallback(pagePath), analysis.headings);
    const description =
      config.sourceVersion === 1
        ? (frontmatter.description as string | null | undefined)
        : normalizeWikiPageDescription(frontmatter.description);
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

    assertValidDocumentResource(pageResource, sourcePath);
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

const WIKI_PAGE_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Keep an unversioned WikiPage spec.description within the WikiPage/v1 schema's 1024-character
 * limit. The cut never splits a surrogate pair, so the result stays well-formed text.
 */
function normalizeWikiPageDescription(description: unknown): string | undefined {
  if (typeof description !== "string") return undefined;
  if (description.length <= WIKI_PAGE_DESCRIPTION_MAX_LENGTH) return description;
  const last = description.charCodeAt(WIKI_PAGE_DESCRIPTION_MAX_LENGTH - 1);
  const end =
    last >= 0xd800 && last <= 0xdbff
      ? WIKI_PAGE_DESCRIPTION_MAX_LENGTH - 1
      : WIKI_PAGE_DESCRIPTION_MAX_LENGTH;
  return description.slice(0, end);
}

/**
 * @internal Check a document resource against its public schema where it is built, so a
 * frontmatter or heading value that the schema refuses fails at its source file with the field
 * name rather than later as an unlocated invalid resource.
 */
export function assertValidDocumentResource(resource: SourceResource, location: string): void {
  const validation = validateResources([resource]);
  if (validation.valid) return;
  const [, section, field] = validation.errors[0].path.split("/");
  throw new PublicCompileError("frontmatter-invalid", location, {
    field: section === "labels" ? "labels" : section === "spec" ? field : undefined,
  });
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
    let bytes: Buffer;
    try {
      bytes = await readRegularFileWithinRoot(filePath, dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const raw = decodeUtf8Document(bytes, pagePath + ext);
    if (!requireUnique) return { filePath, raw };
    if (found)
      throw new PublicCompileError("wiki-page-ambiguous", pagePath + ext, {
        relatedLocation: `${pagePath}${found.filePath.endsWith(".mdx") ? ".mdx" : ".md"}`,
      });
    found = { filePath, raw };
  }
  if (found) return found;
  throw new PublicCompileError("wiki-page-not-found", pagePath);
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

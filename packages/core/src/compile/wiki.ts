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
import { parsePageMetadata } from "../config/source-metadata";
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
import {
  decodeUtf8Document,
  existingDocuments,
  mapWithConcurrency,
  readRegularFileWithinRoot,
} from "./files";
import { PublicCompileError, publicSchemaError } from "./public-errors";
import {
  extractMarkdownTitle,
  parseMarkdownFrontmatter,
  withFileLines,
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
      bodyLinesByResource: discovered.bodyLinesByResource,
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
  if (pagePaths.length !== pages.length)
    throw new PublicCompileError("config-invalid", loadedConfig.path);
  const resolvedFiles = await mapWithConcurrency(pagePaths, PAGE_READ_CONCURRENCY, (pagePath) =>
    readPageFile(dir, pagePath),
  );

  const resources: SourceResource[] = [];
  const diagnostics: CompileResult["diagnostics"] = [];
  const sourcePathsByResource: Record<string, string> = {};
  const bodyLinesByResource: Record<string, number> = {};
  const unvalidatedDocuments: NonNullable<CompileResourceDiscovery["unvalidatedDocuments"]> = [];
  const pageNamesBySource = new Map<string, string>();

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const { filePath, raw } = resolvedFiles[i];
    const sourcePath = `${pagePath}${filePath.endsWith(".mdx") ? ".mdx" : ".md"}`;
    const parsed = parseMarkdownFrontmatter(raw, sourcePath);
    const { content } = parsed;
    let frontmatter;
    try {
      frontmatter = parsePageMetadata(parsed.frontmatter);
    } catch (error) {
      throw publicSchemaError("frontmatter-invalid", sourcePath, error);
    }
    const validation = memo.validate(content, sourcePath);
    diagnostics.push(...withFileLines(validation.errors, parsed.bodyLineOffset));
    const name = frontmatter.id ?? pagePathToName(config.id, pagePath);
    if (!validation.valid) {
      if (!Object.hasOwn(sourcePathsByResource, `WikiPage/${name}`)) {
        pageNamesBySource.set(pagePath, name);
        unvalidatedDocuments.push({
          sourcePath,
          resource: {
            apiVersion: "v1",
            type: "WikiPage",
            name,
            spec: {
              wiki: config.id,
              title: pagePathToTitleFallback(pagePath),
              content: { format: "topik", value: content },
            },
          },
        });
      }
      continue;
    }
    // Page paths are already unique, so a repeated name comes from two frontmatter IDs.
    if (Object.hasOwn(sourcePathsByResource, `WikiPage/${name}`))
      throw new PublicCompileError("frontmatter-invalid", sourcePath, {
        field: "id",
        relatedLocation: sourcePathsByResource[`WikiPage/${name}`],
      });
    pageNamesBySource.set(pagePath, name);
    const analysis = memo.analyze(content, sourcePath);
    diagnostics.push(...withFileLines(analysis.diagnostics, parsed.bodyLineOffset));
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(content, pagePathToTitleFallback(pagePath), analysis.headings);
    const description = frontmatter.description;
    const pageResource: WikiPage = {
      apiVersion: "v1",
      type: "WikiPage",
      name,
      ...(frontmatter.labels !== undefined ? { labels: frontmatter.labels } : {}),
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
    if (parsed.bodyLineOffset)
      bodyLinesByResource[`WikiPage/${pageResource.name}`] = parsed.bodyLineOffset;
  }

  const wikiResource: Wiki = {
    apiVersion: "v1",
    type: "Wiki",
    name: config.id,
    ...(config.labels !== undefined ? { labels: config.labels } : {}),
    spec: {
      title: config.title,
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.navigation
        ? {
            navigation: resolveNavigation(
              config.navigation,
              config.id,
              "",
              pageNamesBySource,
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
    bodyLinesByResource,
    unvalidatedDocuments,
    consumedSourcePaths: [loadedConfig.path],
    assetDirectory: config.assets.directory,
  };
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

/**
 * @internal The Markdown files a Wiki's navigation names and that exist as regular files,
 * whether or not their content is valid. Reads no page content.
 */
export async function listWikiDocuments(dir: string, loaded: LoadedConfig): Promise<string[]> {
  let config;
  try {
    config = parseWikiConfig(loaded.value);
  } catch (error) {
    throw publicSchemaError("config-invalid", loaded.path, error);
  }
  const pages = config.navigation ? collectPages(config.navigation) : [];
  return existingDocuments(
    dir,
    [...new Set(pages.map((page) => page.sourcePath))].flatMap((path) => [
      `${path}.mdx`,
      `${path}.md`,
    ]),
  );
}

async function readPageFile(
  dir: string,
  pagePath: string,
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
        ...(typeof node !== "string" && node.hidden !== undefined ? { hidden: node.hidden } : {}),
      };
    }

    if ("children" in node) {
      const children = resolveNavigation(
        node.children,
        wikiId,
        joinWikiPath(prefix, node.slug),
        pageNamesBySource,
      );
      if (node.type === "group") {
        return {
          type: "group",
          title: node.title,
          ...(node.slug ? { slug: node.slug } : {}),
          ...(node.icon ? { icon: node.icon } : {}),
          ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
          ...(node.expanded !== undefined ? { expanded: node.expanded } : {}),
          children: children as WikiSidebarNavNode[],
        };
      }
      if (node.type === "tab") {
        return {
          type: "tab",
          title: node.title,
          ...(node.slug ? { slug: node.slug } : {}),
          ...(node.icon ? { icon: node.icon } : {}),
          ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
          children: children as WikiDropdownNavNode[] | WikiSidebarNavNode[],
        };
      }
      return {
        type: "dropdown",
        title: node.title,
        ...(node.slug ? { slug: node.slug } : {}),
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
        children: children as WikiSidebarNavNode[],
      };
    }

    if (node.type === "tab") {
      return {
        type: "tab",
        title: node.title,
        href: node.href,
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
      };
    }
    if (node.type === "dropdown") {
      return {
        type: "dropdown",
        title: node.title,
        href: node.href,
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
      };
    }
    return {
      type: "link",
      title: node.title,
      href: node.href,
      ...(node.icon ? { icon: node.icon } : {}),
      ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
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

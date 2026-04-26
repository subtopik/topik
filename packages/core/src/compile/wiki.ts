import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Wiki, WikiNavNode as CompiledWikiNavNode, WikiPage } from "@topik/schema";
import type { Resource } from "../resource";
import { parseWikiConfig, type WikiNavNode } from "../config/wiki";
import { extractAssets } from "./assets";
import { readOptionalConfigFile } from "./config";
import { extractMarkdownTitle, parseMarkdownFrontmatter, type CompileResult } from "./shared";

export interface CompileWikiOptions {
  dir: string;
}

export async function compileWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);

  const raw = await readOptionalConfigFile(dir, ["wiki.yaml", "wiki.yml", "wiki.json"]);
  if (raw == null) {
    return { resources: [] };
  }

  const config = parseWikiConfig(raw);
  const pagePaths = config.navigation ? [...new Set(collectPagePaths(config.navigation))] : [];
  const resolvedFiles = await Promise.all(
    pagePaths.map(async (pagePath) => {
      const filePath = await resolveFilePath(dir, pagePath);
      const raw = await readFile(filePath, "utf-8");
      return { filePath, raw };
    }),
  );

  const resources: Resource[] = [];
  const assetsById = new Map<string, (typeof resources)[number]>();

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const { filePath, raw } = resolvedFiles[i];
    const { frontmatter, content } = parseMarkdownFrontmatter(raw, pagePath);
    const { content: rewritten, assets } = await extractAssets(content, {
      baseDir: dir,
      filePath,
    });
    for (const asset of assets) {
      if (!assetsById.has(asset.name)) {
        assetsById.set(asset.name, asset);
      }
    }
    const name = pagePathToName(pagePath);
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : extractMarkdownTitle(rewritten, name);

    const pageResource: WikiPage = {
      apiVersion: "v1",
      type: "WikiPage",
      name: `${config.id}-${name}`,
      spec: {
        wiki: config.id,
        title,
        content: {
          format: "topik",
          value: rewritten,
        },
      },
    };

    resources.push(pageResource);
  }

  for (const asset of assetsById.values()) {
    resources.push(asset);
  }

  const wikiResource: Wiki = {
    apiVersion: "v1",
    type: "Wiki",
    name: config.id,
    spec: {
      title: config.title,
      ...(config.navigation ? { navigation: resolveNavigation(config.navigation, config.id) } : {}),
      ...(config.theme ? { theme: config.theme } : {}),
    },
  };

  resources.push(wikiResource);

  return { resources };
}

function collectPagePaths(nodes: WikiNavNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (typeof node === "string") {
      paths.push(node);
    } else if ("group" in node || "tab" in node) {
      paths.push(...collectPagePaths(node.children));
    }
  }
  return paths;
}

async function resolveFilePath(dir: string, pagePath: string): Promise<string> {
  for (const ext of [".mdx", ".md"]) {
    const filePath = join(dir, pagePath + ext);
    try {
      await access(filePath);
      return filePath;
    } catch {
      // try next extension
    }
  }
  throw new Error(`Page not found: ${pagePath} (tried .md and .mdx in ${dir})`);
}

function pagePathToSlug(pagePath: string): string {
  if (pagePath === "index") return "";
  return pagePath.replace(/\/index$/, "");
}

export function pagePathToName(pagePath: string): string {
  return pagePath.replace(/^\//, "").replaceAll("/", "-");
}

function resolveNavigation(nodes: WikiNavNode[], wikiId: string): CompiledWikiNavNode[] {
  return nodes.map((node) => {
    if (typeof node === "string") {
      const pageName = `${wikiId}-${pagePathToName(node)}`;
      return { type: "page", page: pageName, slug: pagePathToSlug(node) };
    }

    if ("group" in node || "tab" in node) {
      const isTab = "tab" in node;
      const title = isTab ? node.tab : node.group;
      return {
        type: isTab ? "tab" : "group",
        title,
        ...(node.slug ? { slug: node.slug } : {}),
        ...(node.icon ? { icon: node.icon } : {}),
        children: resolveNavigation(node.children, wikiId),
      };
    }

    return {
      type: "link",
      title: node.title,
      href: node.href,
      ...(node.icon ? { icon: node.icon } : {}),
    };
  });
}
export { extractMarkdownTitle as extractTitle } from "./shared";

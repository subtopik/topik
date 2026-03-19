import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Wiki, WikiNavNode as CompiledWikiNavNode, WikiPage } from "@topik/schema";
import type { Resource } from "../resource";
import { parseWikiConfig, type WikiNavNode } from "../config/wiki";
import { parse as parseYaml } from "yaml";
import { readConfigFile } from "./config";

export interface CompileWikiOptions {
  dir: string;
}

export interface CompileResult {
  resources: Resource[];
}

export async function compileWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);

  const raw = await readConfigFile(dir, ["wiki.yaml", "wiki.yml", "wiki.json"]);
  const config = parseWikiConfig(raw);
  const pagePaths = config.navigation ? [...new Set(collectPagePaths(config.navigation))] : [];
  const fileContents = await Promise.all(
    pagePaths.map(async (pagePath) => {
      const filePath = await resolveFilePath(dir, pagePath);
      return readFile(filePath, "utf-8");
    }),
  );

  const resources: Resource[] = [];

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const { frontmatter, content } = parseFrontmatter(fileContents[i], pagePath);
    const name = pagePathToName(pagePath);
    const title =
      typeof frontmatter.title === "string" ? frontmatter.title : extractTitle(content, name);

    const pageResource: WikiPage = {
      apiVersion: "v1",
      type: "WikiPage",
      name: `${config.id}-${name}`,
      spec: {
        wiki: config.id,
        title,
        content: {
          format: "topik",
          value: content,
        },
      },
    };

    resources.push(pageResource);
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

function parseFrontmatter(
  raw: string,
  pagePath: string,
): { frontmatter: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) {
    try {
      const frontmatter = parseYaml(match[1]);
      if (frontmatter == null) {
        return { frontmatter: {}, content: match[2] };
      }
      if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
        throw new Error("Frontmatter must parse to an object");
      }
      if (
        "title" in frontmatter &&
        frontmatter.title != null &&
        typeof frontmatter.title !== "string"
      ) {
        throw new Error("Frontmatter title must be a string");
      }
      return { frontmatter, content: match[2] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid frontmatter in ${pagePath}: ${message}`, { cause: error });
    }
  }
  return { frontmatter: {}, content: raw };
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

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  return fallback
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

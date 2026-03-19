import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseWikiConfig, type WikiNavNode } from "../config/wiki";
import { parse as parseYaml } from "yaml";
import { readConfigFile } from "./config";

export interface Resource {
  apiVersion: "v1";
  type: string;
  name: string;
  spec: Record<string, unknown>;
}

export interface CompileWikiOptions {
  /** Absolute path to the directory containing wiki.yaml */
  dir: string;
}

export interface CompileResult {
  resources: Resource[];
}

export async function compileWiki(options: CompileWikiOptions): Promise<CompileResult> {
  const dir = resolve(options.dir);

  const raw = await readConfigFile(dir, ["wiki.yaml", "wiki.yml", "wiki.json"]);
  const config = parseWikiConfig(raw);

  // Extract unique page paths referenced in navigation
  const pagePaths = config.navigation ? [...new Set(collectPagePaths(config.navigation))] : [];

  // Read all referenced files in parallel
  const fileContents = await Promise.all(
    pagePaths.map(async (pagePath) => {
      const filePath = await resolveFilePath(dir, pagePath);
      return readFile(filePath, "utf-8");
    }),
  );

  // Build WikiPage resources
  const resources: Resource[] = [];

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const { frontmatter, content } = parseFrontmatter(fileContents[i]);
    const name = pagePathToName(pagePath);
    const title = frontmatter.title ?? extractTitle(content, name);

    resources.push({
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
    });
  }

  // Create Wiki resource
  resources.push({
    apiVersion: "v1",
    type: "Wiki",
    name: config.id,
    spec: {
      title: config.title,
      ...(config.navigation ? { navigation: resolveNavigation(config.navigation, config.id) } : {}),
      ...(config.theme ? { theme: config.theme } : {}),
    },
  });

  return { resources };
}

/** Collect all page paths from the navigation tree. */
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

/** Resolve a page path to a file, trying .mdx and .md extensions. */
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

/** Parse YAML frontmatter from markdown content. */
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) {
    try {
      const frontmatter = parseYaml(match[1]) as Record<string, string>;
      return { frontmatter, content: match[2] };
    } catch {
      return { frontmatter: {}, content: raw };
    }
  }
  return { frontmatter: {}, content: raw };
}

/** Convert a page path to a URL slug, collapsing index files (e.g. "runtime/index" → "runtime"). */
function pagePathToSlug(pagePath: string): string {
  if (pagePath === "index") return "";
  return pagePath.replace(/\/index$/, "");
}

/** Convert a page path (e.g. "runtime/http/server") to a resource name (e.g. "runtime-http-server"). */
export function pagePathToName(pagePath: string): string {
  return pagePath.replace(/^\//, "").replaceAll("/", "-");
}

/**
 * Resolve config nav nodes into compiled schema nav nodes.
 * Config format (Mintlify-style): strings, { group, children }, { href, title }
 * Output format (schema): { type: "page", page, slug }, { type: "group", ... }, { type: "link", ... }
 */
function resolveNavigation(nodes: WikiNavNode[], wikiId: string): Record<string, unknown>[] {
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

/** Extract the title from the first `# heading` in the markdown, or fall back to the name. */
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

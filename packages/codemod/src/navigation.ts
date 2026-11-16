/** Mintlify configuration files, in order of preference. */
export const MINTLIFY_CONFIG_FILES = ["docs.json", "mint.json"] as const;
export type MintlifyConfigFile = (typeof MINTLIFY_CONFIG_FILES)[number];

/** Wiki configuration names read by `@topik/core`; any of them blocks a new `wiki.yaml`. */
export const WIKI_CONFIG_FILES = ["wiki.yaml", "wiki.yml", "wiki.json"] as const;

export interface NavigationConversion {
  /** The `wiki.yaml` source, or `undefined` when the configuration cannot be converted. */
  yaml?: string;
  /** Entries that have no Topik equivalent, prefixed with their location in the configuration. */
  warnings: string[];
}

type Surface = "tab" | "dropdown" | "sidebar";

type NavObject = {
  type: "group" | "tab" | "dropdown";
  title: string;
  href?: string;
  expanded?: boolean;
  hidden?: boolean;
  children?: NavNode[];
};

type NavNode = string | NavObject;

type JsonObject = Record<string, unknown>;

const WIKI_ID_MAX_LENGTH = 46;
const TITLE_MAX_LENGTH = 256;
const DESCRIPTION_MAX_LENGTH = 1024;
const HREF_MAX_LENGTH = 2048;
const MAX_DEPTH = 32;
const PAGE_PATH = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/**
 * Convert Mintlify `docs.json` or legacy `mint.json` navigation to a Topik `wiki.yaml`.
 * `pages` holds the extensionless, `/`-separated paths of the Markdown pages that will
 * exist after the migration; references to anything else are reported, not kept.
 */
export function convertMintlifyNavigation(
  file: MintlifyConfigFile,
  config: unknown,
  pages: ReadonlySet<string>,
): NavigationConversion {
  const converter = new Converter(pages);
  if (!isObject(config)) {
    converter.warn(file, "the configuration is not a JSON object; no wiki.yaml written");
    return { warnings: converter.warnings };
  }
  const name = config.name;
  if (typeof name !== "string" || !name.trim() || name.length > TITLE_MAX_LENGTH) {
    converter.warn("name", "a site name of 1 to 256 characters is required; no wiki.yaml written");
    return { warnings: converter.warnings };
  }
  const id = wikiId(name);
  if (!id) {
    converter.warn(
      "name",
      "no wiki id can be derived from the site name; no wiki.yaml written. Write wiki.yaml by hand",
    );
    return { warnings: converter.warnings };
  }

  let navigation: NavNode[] = [];
  const source = config.navigation;
  if (Array.isArray(source)) navigation = converter.pageList(source, "navigation", 0);
  else if (isObject(source))
    navigation = converter.container(source, "navigation", ROOT_SURFACES, new Set(), 0);
  else if (source !== undefined) converter.warn("navigation", "is not a list or an object");
  else converter.warn("navigation", "is missing; the wiki has no pages");

  if (file === "mint.json") {
    // Legacy tabs and anchors select pages by URL prefix, which Topik has no form for.
    for (const key of ["tabs", "anchors"])
      if (config[key] !== undefined)
        converter.warn(
          key,
          "has no Topik equivalent; not converted, and their groups stay in the sidebar",
        );
  }

  const description =
    typeof config.description === "string" && config.description.length <= DESCRIPTION_MAX_LENGTH
      ? config.description
      : undefined;
  if (config.description !== undefined && description === undefined)
    converter.warn("description", "is not a string of at most 1024 characters; not converted");

  const lines = [`id: ${scalar(id)}`, `title: ${scalar(name)}`];
  if (description !== undefined) lines.push(`description: ${scalar(description)}`);
  lines.push(...field("navigation", navigation, ""));
  return { yaml: `${lines.join("\n")}\n`, warnings: converter.warnings };
}

const ROOT_SURFACES: ReadonlySet<Surface> = new Set(["tab", "dropdown", "sidebar"]);
const TAB_SURFACES: ReadonlySet<Surface> = new Set(["dropdown", "sidebar"]);
const SIDEBAR_SURFACES: ReadonlySet<Surface> = new Set(["sidebar"]);

class Converter {
  readonly warnings: string[] = [];
  private readonly routes = new Map<string, string>();

  constructor(private readonly pages: ReadonlySet<string>) {}

  warn(path: string, message: string): undefined {
    this.warnings.push(`${path}: ${message}`);
    return undefined;
  }

  /** Children of a navigation object, tab, dropdown or anchor, in key order. */
  container(
    value: JsonObject,
    path: string,
    allowed: ReadonlySet<Surface>,
    handled: ReadonlySet<string>,
    depth: number,
  ): NavNode[] {
    const nodes: NavNode[] = [];
    let surface: Surface | undefined;
    for (const [key, child] of Object.entries(value)) {
      if (handled.has(key)) continue;
      const at = `${path}.${key}`;
      // Reject a surface before converting it, so a dropped subtree claims no routes.
      const add = (kind: Surface, convert: (items: readonly unknown[]) => NavNode[]) => {
        if (Array.isArray(child) && !child.length) return;
        if (!allowed.has(kind))
          return this.warn(at, `${plural(kind)} cannot appear here in Topik; not converted`);
        if (surface !== undefined && kind !== surface)
          return this.warn(
            at,
            `${plural(kind)} cannot be mixed with ${plural(surface)} at one level; not converted`,
          );
        if (!Array.isArray(child)) return this.warn(at, "is not a list; not converted");
        const converted = convert(child);
        if (!converted.length) return;
        surface = kind;
        nodes.push(...converted);
      };
      if (key === "tabs")
        add("tab", (items) =>
          this.each(items, at, depth, (item, itemPath) => this.tab(item, itemPath, depth)),
        );
      else if (key === "dropdowns")
        add("dropdown", (items) =>
          this.each(items, at, depth, (item, itemPath) => this.dropdown(item, itemPath, depth)),
        );
      else if (key === "groups")
        add("sidebar", (items) =>
          this.each(items, at, depth, (item, itemPath) => this.group(item, itemPath, depth)),
        );
      else if (key === "pages") add("sidebar", (items) => this.pageList(items, at, depth));
      else if (key === "icon") this.warn(at, "icons are dropped");
      else if (key !== "$schema") this.warn(at, "has no Topik equivalent; not converted");
    }
    return nodes;
  }

  /** A list of page references and nested groups. */
  pageList(items: readonly unknown[], path: string, depth: number): NavNode[] {
    return this.each(items, path, depth, (item, itemPath) => {
      if (typeof item === "string") return this.page(item, itemPath);
      if (isObject(item) && "group" in item) return this.group(item, itemPath, depth);
      this.warn(itemPath, "is not a page reference or a group; not converted");
    });
  }

  private each(
    items: readonly unknown[],
    path: string,
    depth: number,
    convert: (item: unknown, path: string) => NavNode | undefined,
  ): NavNode[] {
    if (depth >= MAX_DEPTH) {
      this.warn(path, `nesting deeper than ${MAX_DEPTH} levels is not converted`);
      return [];
    }
    const nodes: NavNode[] = [];
    items.forEach((item, index) => {
      const node = convert(item, `${path}[${index}]`);
      if (node !== undefined) nodes.push(node);
    });
    return nodes;
  }

  private page(reference: string, path: string): NavNode | undefined {
    const page = reference.replace(/^\/+/, "");
    const label = JSON.stringify(reference.length > 80 ? `${reference.slice(0, 80)}…` : reference);
    if (!PAGE_PATH.test(page)) {
      this.warn(
        path,
        `page ${label} is not a lowercase Topik page path (letters, digits and hyphens separated by /); not converted`,
      );
      return;
    }
    if (!this.pages.has(page)) {
      this.warn(path, `page ${label} has no .md or .mdx file in the directory; not converted`);
      return;
    }
    const route = page === "index" ? "" : page.replace(/\/index$/, "");
    const previous = this.routes.get(route);
    if (previous !== undefined) {
      this.warn(path, `page ${label} repeats the route of ${previous}; not converted`);
      return;
    }
    this.routes.set(route, path);
    return page;
  }

  private group(item: unknown, path: string, depth: number): NavNode | undefined {
    if (!isObject(item)) return this.warn(path, "is not an object; not converted");
    const title = this.title(item.group, `${path}.group`);
    if (title === undefined) return;
    const node: NavObject = { type: "group", title, children: [] };
    for (const [key, value] of Object.entries(item)) {
      const at = `${path}.${key}`;
      if (key === "group") continue;
      else if (key === "pages") {
        if (Array.isArray(value)) node.children = this.pageList(value, at, depth + 1);
        else this.warn(at, "is not a list; not converted");
      } else if (key === "expanded" || key === "hidden") {
        if (typeof value === "boolean") node[key] = value;
        else this.warn(at, "is not a boolean; not converted");
      } else if (key === "icon") this.warn(at, "icons are dropped");
      else this.warn(at, "has no Topik equivalent; not converted");
    }
    return node;
  }

  private tab(item: unknown, path: string, depth: number): NavNode | undefined {
    return this.switcher("tab", item, path, depth, TAB_SURFACES);
  }

  private dropdown(item: unknown, path: string, depth: number): NavNode | undefined {
    return this.switcher("dropdown", item, path, depth, SIDEBAR_SURFACES);
  }

  private switcher(
    type: "tab" | "dropdown",
    item: unknown,
    path: string,
    depth: number,
    allowed: ReadonlySet<Surface>,
  ): NavNode | undefined {
    if (!isObject(item)) return this.warn(path, "is not an object; not converted");
    const title = this.title(item[type], `${path}.${type}`);
    if (title === undefined) return;
    const node: NavObject = { type, title };
    if (typeof item.hidden === "boolean") node.hidden = item.hidden;
    else if (item.hidden !== undefined)
      this.warn(`${path}.hidden`, "is not a boolean; not converted");
    const handled = new Set([type, "hidden", "href"]);
    if (item.href !== undefined) {
      const href = externalHref(item.href);
      const hasChildren = Object.keys(item).some((key) => CONTENT_KEYS.has(key));
      if (href === undefined || hasChildren) {
        this.warn(
          `${path}.href`,
          hasChildren
            ? `a ${type} with both a link and pages is not converted`
            : "only external http(s) URLs are converted",
        );
        return;
      }
      for (const key of Object.keys(item))
        if (key === "icon") this.warn(`${path}.icon`, "icons are dropped");
        else if (!handled.has(key))
          this.warn(`${path}.${key}`, "has no Topik equivalent; not converted");
      return { ...node, href };
    }
    return { ...node, children: this.container(item, path, allowed, handled, depth + 1) };
  }

  private title(value: unknown, path: string): string | undefined {
    if (typeof value === "string" && value.trim() && value.length <= TITLE_MAX_LENGTH) return value;
    return this.warn(path, "a title of 1 to 256 characters is required; entry not converted");
  }
}

/** Keys that give a Mintlify navigation element its own content. */
const CONTENT_KEYS = new Set([
  "tabs",
  "dropdowns",
  "anchors",
  "groups",
  "pages",
  "menu",
  "versions",
  "languages",
  "products",
  "openapi",
  "asyncapi",
]);

function plural(surface: Surface): string {
  return surface === "sidebar" ? "groups and pages" : `${surface}s`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function externalHref(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > HREF_MAX_LENGTH) return;
  if (!/^https?:\/\/[^\s/?#]+/.test(value) || /\s/.test(value)) return;
  // The URL parser silently drops some control characters; refuse them instead.
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return;
  }
}

/** A lowercase DNS-style id that leaves room for page-name hashes. */
function wikiId(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, WIKI_ID_MAX_LENGTH)
    .replace(/-+$/, "");
}

/** A YAML scalar: plain when unambiguous, otherwise JSON-quoted (valid YAML). */
function scalar(value: string): string {
  return /^[A-Za-z][A-Za-z0-9 /-]*$/.test(value) &&
    !value.endsWith(" ") &&
    !/^(?:y|n|yes|no|on|off|true|false|null)$/i.test(value)
    ? value
    : JSON.stringify(value);
}

function field(key: string, nodes: readonly NavNode[], indent: string): string[] {
  if (!nodes.length) return [`${indent}${key}: []`];
  return [`${indent}${key}:`, ...nodes.flatMap((node) => item(node, `${indent}  `))];
}

function item(node: NavNode, indent: string): string[] {
  if (typeof node === "string") return [`${indent}- ${scalar(node)}`];
  const inner = `${indent}  `;
  const lines = [`${indent}- type: ${node.type}`, `${inner}title: ${scalar(node.title)}`];
  if (node.href !== undefined) lines.push(`${inner}href: ${JSON.stringify(node.href)}`);
  if (node.expanded !== undefined) lines.push(`${inner}expanded: ${node.expanded}`);
  if (node.hidden !== undefined) lines.push(`${inner}hidden: ${node.hidden}`);
  if (node.children !== undefined) lines.push(...field("children", node.children, inner));
  return lines;
}

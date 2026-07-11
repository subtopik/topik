import type {
  WikiDropdownNavNode,
  WikiExternalDropdownNavNode,
  WikiExternalTabNavNode,
  WikiInternalDropdownNavNode,
  WikiInternalTabNavNode,
  WikiNavigation,
  WikiNavContainerNode,
  WikiNavNode,
  WikiPageNavNode,
  WikiTabNavNode,
} from "./wiki";

const INTERNAL_WIKI_ORIGIN = "https://topik.invalid";

export type ResolvedWikiPage = {
  /** The compiled WikiPage resource name. */
  page: string;
  /** The page navigation node from the Wiki resource. */
  node: WikiPageNavNode;
  /** Public path without a leading slash. */
  route: string;
  /** Logical Markdown source path without an extension. */
  sourcePath: string;
  /** Internal navigation containers from outermost to innermost. */
  ancestors: readonly WikiNavContainerNode[];
};

export type ResolvedWikiNavigation = {
  pages: readonly ResolvedWikiPage[];
  pageByName: ReadonlyMap<string, ResolvedWikiPage>;
  pageByRoute: ReadonlyMap<string, ResolvedWikiPage>;
};

export type ResolvedWikiContentLink = {
  page: ResolvedWikiPage;
  route: string;
  hash: string;
};

/** Returns true for tab, dropdown, and group nodes containing navigation children. */
export function hasWikiNavChildren(node: WikiNavNode): node is WikiNavContainerNode {
  return "children" in node;
}

export function isInternalWikiTab(node: WikiNavNode): node is WikiInternalTabNavNode {
  return node.type === "tab" && "children" in node;
}

export function isExternalWikiTab(node: WikiNavNode): node is WikiExternalTabNavNode {
  return node.type === "tab" && "href" in node;
}

export function isInternalWikiDropdown(node: WikiNavNode): node is WikiInternalDropdownNavNode {
  return node.type === "dropdown" && "children" in node;
}

export function isExternalWikiDropdown(node: WikiNavNode): node is WikiExternalDropdownNavNode {
  return node.type === "dropdown" && "href" in node;
}

/** Resolves page routes, source paths, and navigation ancestry from a compiled Wiki tree. */
export function resolveWikiNavigation(
  navigation: WikiNavigation | readonly WikiNavNode[],
): ResolvedWikiNavigation {
  const pages: ResolvedWikiPage[] = [];
  const pageByName = new Map<string, ResolvedWikiPage>();
  const pageByRoute = new Map<string, ResolvedWikiPage>();

  const visit = (
    nodes: readonly WikiNavNode[],
    prefix: string,
    ancestors: readonly WikiNavContainerNode[],
  ) => {
    for (const node of nodes) {
      if (node.type === "page") {
        const route = joinWikiPath(prefix, node.slug);
        const resolved: ResolvedWikiPage = {
          page: node.page,
          node,
          route,
          sourcePath: joinWikiPath(prefix, node.slug || "index"),
          ancestors,
        };
        if (pageByName.has(node.page)) {
          throw new Error(`Wiki navigation contains page ${node.page} more than once`);
        }
        if (pageByRoute.has(route)) {
          throw new Error(`Wiki navigation contains duplicate route /${route}`);
        }
        pages.push(resolved);
        pageByName.set(node.page, resolved);
        pageByRoute.set(route, resolved);
      } else if (hasWikiNavChildren(node)) {
        visit(node.children, joinWikiPath(prefix, node.slug), [...ancestors, node]);
      }
    }
  };

  visit(navigation, "", []);
  return { pages, pageByName, pageByRoute };
}

/** Finds the first page node in navigation order, ignoring external destinations. */
export function findFirstWikiPage(
  navigation: WikiNavigation | readonly WikiNavNode[],
): WikiPageNavNode | null {
  for (const node of navigation) {
    if (node.type === "page") return node;
    if (hasWikiNavChildren(node)) {
      const page = findFirstWikiPage(node.children);
      if (page) return page;
    }
  }
  return null;
}

/** Returns the internal containers owning a page, or an empty array for an unknown page. */
export function findWikiPageAncestors(
  resolved: ResolvedWikiNavigation,
  pageName: string,
): readonly WikiNavContainerNode[] {
  return resolved.pageByName.get(pageName)?.ancestors ?? [];
}

/** Resolves an internal Markdown link against the logical source path of its current page. */
export function resolveWikiContentHref(
  href: string,
  currentPageName: string,
  resolved: ResolvedWikiNavigation,
): ResolvedWikiContentLink | null {
  if (href.startsWith("asset:")) return null;
  const currentPage = resolved.pageByName.get(currentPageName);
  if (!currentPage) return null;

  if (href.startsWith("#")) {
    return { page: currentPage, route: currentPage.route, hash: href.slice(1) };
  }

  let url: URL;
  try {
    url = new URL(href, `${INTERNAL_WIKI_ORIGIN}/${currentPage.sourcePath}`);
  } catch {
    return null;
  }
  if (url.origin !== INTERNAL_WIKI_ORIGIN) return null;

  const route = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.(?:mdx?|markdown)$/i, "")
    .replace(/\/index$/, "");
  const page = resolved.pageByRoute.get(route);
  return page ? { page, route, hash: url.hash.replace(/^#/, "") } : null;
}

export function joinWikiPath(prefix: string, slug?: string): string {
  if (!slug) return prefix;
  return prefix ? `${prefix}/${slug}` : slug;
}

// These aliases keep consumer annotations concise without weakening the resource unions.
export type InternalWikiTab = WikiInternalTabNavNode;
export type ExternalWikiTab = WikiExternalTabNavNode;
export type InternalWikiDropdown = WikiInternalDropdownNavNode;
export type ExternalWikiDropdown = WikiExternalDropdownNavNode;
export type WikiSwitcherNode = WikiTabNavNode | WikiDropdownNavNode;

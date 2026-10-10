import { parseTopikResourceReference, validateTopikBrowserHref } from "@topik/content";

/** Astro entry IDs contain resource names; slugs contain application route metadata. */
export interface TopikLinkEntry {
  id: string;
  data: { slug: string };
}

export interface TopikLinkDiagnostic {
  id: "TOPIK_RESOURCE_REFERENCE_UNRESOLVED";
  message: string;
}

export interface TopikLinkResolverOptions<
  WikiEntry extends TopikLinkEntry = TopikLinkEntry,
  GuideEntry extends TopikLinkEntry = TopikLinkEntry,
> {
  wikiPages?: readonly WikiEntry[];
  guides?: readonly GuideEntry[];
  /** Assign a browser URL using the application's wiki prefix and entry metadata. */
  resolveWikiPage?: (entry: WikiEntry) => string | undefined;
  /** Assign a browser URL using the application's guide prefix and entry metadata. */
  resolveGuide?: (entry: GuideEntry) => string | undefined;
  onDiagnostic?: (diagnostic: TopikLinkDiagnostic) => void;
}

/**
 * Build a framework-neutral resolveLink hook from Astro collection entries. Loaders preserve
 * portable ref:// content; applications supply the catalogue and decide each public route.
 */
export function createTopikLinkResolver<
  WikiEntry extends TopikLinkEntry = TopikLinkEntry,
  GuideEntry extends TopikLinkEntry = TopikLinkEntry,
>(options: TopikLinkResolverOptions<WikiEntry, GuideEntry>): (href: string) => string | undefined {
  const wikiPages = indexEntries(options.wikiPages ?? []);
  const guides = indexEntries(options.guides ?? []);

  return (href) => {
    const reference = parseTopikResourceReference(href);
    if (reference === null) {
      return validateTopikBrowserHref(href).length === 0 ? href : undefined;
    }
    let route: string | undefined;
    try {
      if (reference.type === "WikiPage") {
        const entry = wikiPages.get(reference.name);
        if (entry !== undefined) route = options.resolveWikiPage?.(entry);
      } else {
        const entry = guides.get(reference.name);
        if (entry !== undefined) route = options.resolveGuide?.(entry);
      }
    } catch {
      route = undefined;
    }
    if (
      typeof route === "string" &&
      !/^asset:/iu.test(route) &&
      validateTopikBrowserHref(route).length === 0
    ) {
      const hashAt = route.indexOf("#");
      const routeHash = hashAt < 0 ? "" : route.slice(hashAt);
      const withoutHash = hashAt < 0 ? route : route.slice(0, hashAt);
      const queryAt = withoutHash.indexOf("?");
      const routeSearch = queryAt < 0 ? "" : withoutHash.slice(queryAt);
      const pathname = queryAt < 0 ? withoutHash : withoutHash.slice(0, queryAt);
      const resolved =
        pathname +
        (reference.search || routeSearch) +
        (reference.hash ? `#${reference.hash}` : routeHash);
      if (validateTopikBrowserHref(resolved).length === 0) return resolved;
    }
    options.onDiagnostic?.({
      id: "TOPIK_RESOURCE_REFERENCE_UNRESOLVED",
      message: "Resource reference could not be resolved to a browser URL",
    });
    return undefined;
  };
}

function indexEntries<Entry extends TopikLinkEntry>(entries: readonly Entry[]): Map<string, Entry> {
  const indexed = new Map<string, Entry>();
  for (const entry of entries) {
    if (indexed.has(entry.id)) {
      throw new Error("Resource catalogue contains duplicate names for a resource type");
    }
    indexed.set(entry.id, entry);
  }
  return indexed;
}

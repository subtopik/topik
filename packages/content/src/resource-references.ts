/** Version of the portable compiled-content resource reference contract. */
export const TOPIK_RESOURCE_REFERENCE_VERSION = 1 as const;

export interface TopikResourceReference {
  /** Schema resource type; no repository or application namespace is implied. */
  type: "WikiPage" | "Guide";
  /** Schema resource name (at most 63 characters), independent of its public route. */
  name: string;
  /** URI query, including its leading '?' when present. */
  search: string;
  /** URI fragment, without a leading '#'. */
  hash: string;
}

const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RESOURCE_REFERENCE = /^ref:\/\/(wiki-page|guide)\/([^/?#]+)(?:\?[^#]*)?(?:#.*)?$/iu;

/** Parse an explicit resource identity without consulting routes or fetching a catalogue. */
export function parseTopikResourceReference(href: string): TopikResourceReference | null {
  if (typeof href !== "string" || /[\p{Cc}\p{White_Space}]/u.test(href)) return null;
  const match = RESOURCE_REFERENCE.exec(href);
  if (!match) return null;

  try {
    const name = decodeURIComponent(match[2]);
    if (name.length > 63 || !RESOURCE_NAME.test(name)) return null;
    const url = new URL(href);
    // Keep encoded query and fragment text intact; decoding only checks malformed escapes.
    decodeURIComponent(url.search);
    decodeURIComponent(url.hash);
    return {
      type: match[1].toLowerCase() === "wiki-page" ? "WikiPage" : "Guide",
      name,
      search: url.search,
      hash: url.hash.slice(1),
    };
  } catch {
    return null;
  }
}

/** Serialize an identity as a canonical ref:// URI; this is not a browser-facing URL. */
export function serializeTopikResourceReference(reference: TopikResourceReference): string {
  if (
    (reference.type !== "WikiPage" && reference.type !== "Guide") ||
    typeof reference.name !== "string" ||
    reference.name.length > 63 ||
    !RESOURCE_NAME.test(reference.name) ||
    typeof reference.search !== "string" ||
    (reference.search !== "" && !reference.search.startsWith("?")) ||
    reference.search.includes("#") ||
    typeof reference.hash !== "string"
  ) {
    throw new TypeError("Resource reference is not valid");
  }
  const kind = reference.type === "WikiPage" ? "wiki-page" : "guide";
  const href = `ref://${kind}/${reference.name}${reference.search}${reference.hash ? `#${reference.hash}` : ""}`;
  const parsed = parseTopikResourceReference(href);
  if (!parsed) throw new TypeError("Resource reference is not valid");
  return `ref://${kind}/${parsed.name}${parsed.search}${parsed.hash ? `#${parsed.hash}` : ""}`;
}

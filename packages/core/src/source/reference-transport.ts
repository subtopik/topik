import {
  parseTopikResourceReference,
  rewriteTopikNavigationReferences,
  type TopikNavigationReference,
} from "@topik/content";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import {
  resolveWikiContentHref,
  resolveWikiContentReference,
  type ResolvedWikiContentLink,
  type ResolvedWikiNavigation,
} from "../wiki-navigation";

/** A derived source repair, as reported in a source plan. */
export interface SourceDerivedRepair {
  resource: string;
  kind: "navigation" | "reference";
  position?: string;
  before?: string;
  after?: string;
  target?: string;
}

/** The parts of a resolved Wiki or Course content link that a transport compares. */
export interface SavedReferenceLink {
  page: { page: string };
  search: string;
  hash: string;
}

/**
 * Why a reference cannot be transported. `unresolved`: no target in its saved context;
 * `removed`: its saved target page is gone; `unrepresentable`: no current href proves the
 * saved target; `rewrite`: the content's references cannot be rewritten at all.
 */
export type SavedReferenceTransportFailure =
  | "unresolved"
  | "removed"
  | "unrepresentable"
  | "rewrite";

export interface SavedReferenceTransport<Link extends SavedReferenceLink> {
  /** Resource key the repairs are reported for. */
  resource: string;
  /** Authoring content whose navigation references are transported. */
  content: string;
  /** Classify an href against the saved (pre-change) navigation. */
  resolveSaved: (
    href: string,
  ) => { kind: "page"; target: Link } | { kind: "asset" | "external" | "unresolved" };
  /** Resolve an href against the current navigation. */
  resolveCurrent: (href: string) => Link | null;
  /** Public route of a page in the current navigation, or undefined when it is gone. */
  currentRoute: (page: string) => string | undefined;
  repairs: SourceDerivedRepair[];
  /** Raise the caller's diagnostic for a failure; each caller keeps its own codes and messages. */
  fail: (failure: SavedReferenceTransportFailure) => never;
  /** Transport a reference with no saved navigation target, such as a cross-source path. */
  resolveOtherReference?: (href: string) => string | undefined;
  /** References that name files or folders rather than pages are left untouched. */
  isNonPageReference?: (reference: TopikNavigationReference) => boolean;
  /** A current target that the filesystem shadows must be rewritten even when it still matches. */
  isCurrentShadowed?: (reference: TopikNavigationReference, current: Link | null) => boolean;
}

const routeHref = (route: string, link: SavedReferenceLink): string =>
  `/${route.split("/").map(encodeURIComponent).join("/")}${link.search}${link.hash ? `#${link.hash}` : ""}`;

/**
 * Carry each authored page reference from its saved navigation to the current one. A
 * reference whose target, query and fragment still resolve identically is kept; any other
 * is rewritten to the root-relative route of its saved target and proven to resolve back.
 */
export function transportSavedReferences<Link extends SavedReferenceLink>(
  transport: SavedReferenceTransport<Link>,
): { content: string; changed: boolean } {
  // An explicit annotation lets control flow treat each call as terminating.
  const fail: (failure: SavedReferenceTransportFailure) => never = transport.fail;
  const rewritten = rewriteTopikNavigationReferences(
    transport.content,
    (reference) => {
      // Compiled resource references have project-wide identity semantics.
      if (parseTopikResourceReference(reference.href) || transport.isNonPageReference?.(reference))
        return undefined;
      const saved = transport.resolveSaved(reference.href);
      if (saved.kind === "unresolved") {
        const other = transport.resolveOtherReference?.(reference.href);
        if (other !== undefined) return other;
        fail("unresolved");
      }
      if (saved.kind !== "page") return undefined;
      const before = saved.target;
      const after = transport.resolveCurrent(reference.href);
      if (
        !transport.isCurrentShadowed?.(reference, after) &&
        after?.page.page === before.page.page &&
        after.search === before.search &&
        after.hash === before.hash
      )
        return undefined;
      const route = transport.currentRoute(before.page.page);
      if (route === undefined) fail("removed");
      const href = routeHref(route, before);
      const proof = transport.resolveCurrent(href);
      if (
        proof?.page.page !== before.page.page ||
        proof.search !== before.search ||
        proof.hash !== before.hash
      )
        fail("unrepresentable");
      transport.repairs.push({
        resource: transport.resource,
        kind: "reference",
        position: reference.position,
        before: reference.href,
        after: href,
        target: before.page.page,
      });
      return href;
    },
    { allowCompiledAssetReferences: true },
  );
  if (!rewritten.ok) fail("rewrite");
  return { content: rewritten.content, changed: rewritten.changes.length > 0 };
}

/** Transport saved Wiki references to the current navigation. */
export function transportWikiReferences(
  page: WikiPage,
  saved: ResolvedWikiNavigation,
  current: ResolvedWikiNavigation,
  repairs: SourceDerivedRepair[],
  options: Pick<
    SavedReferenceTransport<ResolvedWikiContentLink>,
    "fail" | "resolveOtherReference" | "isNonPageReference" | "isCurrentShadowed"
  >,
): { content: string; changed: boolean } {
  return transportSavedReferences({
    ...options,
    resource: `WikiPage/${page.name}`,
    content: page.spec.content.value,
    resolveSaved: (href) => resolveWikiContentReference(href, page.name, saved),
    resolveCurrent: (href) => resolveWikiContentHref(href, page.name, current),
    currentRoute: (name) => current.pageByName.get(name)?.route,
    repairs,
  });
}

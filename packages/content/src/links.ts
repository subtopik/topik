import type { TopikContentCache } from "./parse-cache.js";
import type { Heading } from "mdast";
import type { ContentDocument, TreeNode } from "./model.js";
import type { TopikContentConfig } from "./config.js";
import { plainText } from "./traversal.js";
import { indexDocument, isReference, type DocumentIndex } from "./document-index.js";
type ValidationError = { id: string; level: "error"; message: string };
import { isTopikGeneratedAssetName } from "./asset-reference-policy.js";
import {
  anchorIds,
  explicitId,
  isAnchorNode,
  type TopikAnchor,
  type TopikHeading,
} from "./headings";
import { parseTopikContent } from "./content";
import { parseTopikResourceReference } from "./resource-references.js";
import {
  sanitizeTopikContentDiagnostic,
  topikLinkDiagnosticMessage,
  type TopikContentDiagnostic,
} from "./diagnostics";
import { hasControlCharacters } from "./text-controls.js";

const ALLOWED_SCHEMES = new Set(["asset", "http", "https", "mailto", "tel"]);
const UNSAFE_SCHEMES = new Set(["data", "javascript", "vbscript"]);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const TOPIK_BASE_URL = new URL("https://topik.local/");

export type TopikContentLinkKind = "card" | "link";

export interface TopikContentLink {
  file?: string;
  href: string;
  kind: TopikContentLinkKind;
  lines: number[];
  /** One-based source column of the link or card, when available. */
  column?: number;
}

export interface TopikAnalyzedHeading extends TopikHeading {
  file?: string;
  lines: number[];
}

export interface TopikAnalyzedAnchor extends TopikAnchor {
  file?: string;
  lines: number[];
}

export interface AnalyzeTopikContentResult {
  diagnostics: TopikContentDiagnostic[];
  headings: TopikAnalyzedHeading[];
  /** Every link target: headings and accordions, in document order. */
  anchors: TopikAnalyzedAnchor[];
  links: TopikContentLink[];
}

export interface AnalyzeTopikContentOptions {
  file?: string;
  config?: TopikContentConfig;
  /** @internal Parse results shared with other calls given the same cache. */
  cache?: TopikContentCache;
}

export function analyzeTopikContent(
  source: string,
  options: AnalyzeTopikContentOptions = {},
): AnalyzeTopikContentResult {
  const ast = parseTopikContent(source, {
    config: options.config,
    cache: options.cache,
  });
  return analyzeDocument(ast, options.file);
}

/** @internal Share analysis with validation without reparsing source. */
export function analyzeDocument(
  ast: ContentDocument,
  file?: string,
  index: DocumentIndex = indexDocument(ast),
): AnalyzeTopikContentResult {
  const anchorNodes = index.entries
    .filter(({ node }) => isAnchorNode(node))
    .map(({ node }) => node);
  const explicitIdNodes = new Map<string, TreeNode[]>();

  for (const node of anchorNodes) {
    const id = explicitId(node);
    if (typeof id !== "string" || !id) continue;
    const nodes = explicitIdNodes.get(id) ?? [];
    nodes.push(node);
    explicitIdNodes.set(id, nodes);
  }

  const assigned = anchorIds(anchorNodes);
  const anchors = assigned.map((anchor, index) => ({
    ...anchor,
    ...locationFields(anchorNodes[index], file),
  }));
  const headings = anchorNodes.flatMap((node, index) =>
    node.type === "heading"
      ? [
          {
            id: assigned[index].id,
            level: (node as Heading).depth,
            title: plainText(node).trim().replace(/\s+/g, " "),
            ...(assigned[index].positional ? { positional: true as const } : {}),
            ...locationFields(node, file),
          },
        ]
      : [],
  );
  const diagnostics: TopikContentDiagnostic[] = [];

  for (const [id, nodes] of explicitIdNodes) {
    for (const node of nodes.slice(1)) {
      diagnostics.push({
        id: "heading-id-duplicate",
        type: node.type === "heading" ? "heading" : "accordion",
        level: "error",
        message: `Explicit ID '${id}' is used more than once in this document.`,
        ...sourceLocation(node, file),
      });
    }
  }

  const links: TopikContentLink[] = [];
  for (const { node } of index.entries) {
    const kind = linkKind(node);
    if (!kind) continue;
    const resource = node as TreeNode & { url?: string; identifier?: string };
    const href =
      kind === "card"
        ? node.props?.href
        : isReference(node)
          ? index.resolve(node)?.url
          : resource.url;
    if (typeof href === "string") links.push({ href, kind, ...sourceLocation(node, file) });
  }

  return {
    diagnostics: diagnostics.map(sanitizeTopikContentDiagnostic),
    headings,
    anchors,
    links,
  };
}

export function validateTopikHref(value: unknown): ValidationError[] {
  if (typeof value !== "string") return [];
  if (value.length === 0) {
    return [linkError("link-href-empty")];
  }
  if (value !== value.trim()) {
    return [linkError("link-url-invalid")];
  }
  if (hasControlCharacters(value)) {
    return [linkError("link-url-invalid")];
  }
  if (isNetworkPathReference(value)) {
    return [linkError("link-url-protocol-relative")];
  }

  const explicitScheme = SCHEME.exec(value)?.[1].toLowerCase();

  if (explicitScheme === "ref") {
    return parseTopikResourceReference(value) ? [] : [linkError("link-reference-invalid")];
  }

  if (explicitScheme === "asset") {
    return isTopikGeneratedAssetName(value.slice("asset:".length))
      ? []
      : [linkError("link-asset-invalid")];
  }

  try {
    const parsed = new URL(value, TOPIK_BASE_URL);
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    if (!ALLOWED_SCHEMES.has(scheme)) {
      return [
        linkError(UNSAFE_SCHEMES.has(scheme) ? "link-scheme-unsafe" : "link-scheme-unsupported"),
      ];
    }
    if (!explicitScheme && parsed.origin !== TOPIK_BASE_URL.origin) {
      return [linkError("link-url-protocol-relative")];
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return [linkError("link-url-credentials")];
    }
    if ((scheme === "http" || scheme === "https") && !parsed.hostname) {
      return [linkError("link-url-invalid")];
    }
    if ((scheme === "mailto" || scheme === "tel") && !parsed.pathname) {
      return [linkError("link-url-invalid")];
    }
    if (parsed.hash) decodeURIComponent(parsed.hash.slice(1));
  } catch {
    return [linkError("link-url-invalid")];
  }

  return [];
}

/** Admit only resolved hrefs at a boundary that can emit browser navigation. */
export function validateTopikBrowserHref(value: unknown): ValidationError[] {
  if (typeof value === "string" && SCHEME.exec(value)?.[1].toLowerCase() === "ref") {
    return [linkError("link-reference-unresolved")];
  }
  return validateTopikHref(value);
}

export function validateTopikNavigationHref(value: unknown): ValidationError[] {
  if (typeof value === "string" && SCHEME.exec(value)?.[1].toLowerCase() === "asset") {
    return [linkError("link-asset-navigation-unsupported")];
  }
  return validateTopikHref(value);
}

function linkKind(node: TreeNode): TopikContentLinkKind | undefined {
  if (node.type === "link" || node.type === "linkReference") return "link";
  if (node.type === "topikComponent" && node.name === "card") return "card";
  return undefined;
}

function locationFields(node: TreeNode, file?: string): { file?: string; lines: number[] } {
  return { ...(file ? { file } : {}), lines: node.position ? [node.position.start.line] : [] };
}

/** Line and column of a node's start, for diagnostics and the links they refer to. */
function sourceLocation(
  node: TreeNode,
  file?: string,
): { file?: string; lines: number[]; column?: number } {
  return {
    ...locationFields(node, file),
    ...(node.position ? { column: node.position.start.column } : {}),
  };
}

function linkError(id: string): ValidationError {
  const message = topikLinkDiagnosticMessage(id);
  if (message === undefined) throw new TypeError("Unknown link diagnostic identifier");
  return { id, level: "error", message };
}

function isNetworkPathReference(value: string): boolean {
  const isPathSeparator = (character: string | undefined) =>
    character === "/" || character === "\\";
  return isPathSeparator(value[0]) && isPathSeparator(value[1]);
}

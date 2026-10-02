import type { Heading } from "mdast";
import type { ContentDocument, TreeNode } from "./model.js";
import type { TopikContentConfig } from "./config.js";
import { walkContent } from "./traversal.js";
import { indexDocument, isReference, type DocumentIndex } from "./document-index.js";
type ValidationError = { id: string; level: "error"; message: string };
import { isTopikGeneratedAssetName } from "./asset-reference-policy.js";
import { assignHeadingIds, type TopikHeading } from "./headings";
import { parseTopikContent } from "./content";
import {
  sanitizeTopikContentDiagnostic,
  topikLinkDiagnosticMessage,
  type TopikContentDiagnostic,
} from "./diagnostics";

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
}

export interface TopikAnalyzedHeading extends TopikHeading {
  file?: string;
  lines: number[];
}

export interface AnalyzeTopikContentResult {
  diagnostics: TopikContentDiagnostic[];
  headings: TopikAnalyzedHeading[];
  links: TopikContentLink[];
}

export interface AnalyzeTopikContentOptions {
  file?: string;
  config?: TopikContentConfig;
}

export function analyzeTopikContent(
  source: string,
  options: AnalyzeTopikContentOptions = {},
): AnalyzeTopikContentResult {
  const ast = parseTopikContent(source, { file: options.file, config: options.config });
  return analyzeDocument(ast, options.file);
}

/** @internal Share analysis with validation without reparsing source. */
export function analyzeDocument(
  ast: ContentDocument,
  file?: string,
  index: DocumentIndex = indexDocument(ast),
): AnalyzeTopikContentResult {
  const headingNodes = index.entries
    .filter(({ node }) => node.type === "heading")
    .map(({ node }) => node as Heading);
  const explicitIdNodes = new Map<string, TreeNode[]>();

  for (const node of headingNodes) {
    const id = (node as Heading).data?.topikId;
    if (!id) continue;
    const nodes = explicitIdNodes.get(id) ?? [];
    nodes.push(node);
    explicitIdNodes.set(id, nodes);
  }

  const assignedHeadings = assignHeadingIds(headingNodes);
  const headings = assignedHeadings.map((heading, index) => ({
    ...heading,
    ...locationFields(headingNodes[index], file),
  }));
  const diagnostics: TopikContentDiagnostic[] = [];

  for (const [id, nodes] of explicitIdNodes) {
    for (const node of nodes.slice(1)) {
      diagnostics.push({
        id: "heading-id-duplicate",
        type: "heading",
        level: "error",
        message: `Explicit heading ID '${id}' is used more than once in this document.`,
        ...locationFields(node, file),
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
    if (typeof href === "string") links.push({ href, kind, ...locationFields(node, file) });
  }

  return {
    diagnostics: diagnostics.map(sanitizeTopikContentDiagnostic),
    headings,
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
  if (hasAsciiControl(value)) {
    return [linkError("link-url-invalid")];
  }
  if (isNetworkPathReference(value)) {
    return [linkError("link-url-protocol-relative")];
  }

  const explicitScheme = SCHEME.exec(value)?.[1].toLowerCase();

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

export function validateTopikNavigationHref(value: unknown): ValidationError[] {
  if (typeof value === "string" && SCHEME.exec(value)?.[1].toLowerCase() === "asset") {
    return [linkError("link-asset-navigation-unsupported")];
  }
  return validateTopikHref(value);
}

/** Remove invalid navigation attributes before a renderer can emit a browser-facing URL. */
export function removeInvalidTopikNavigationReferences(root: ContentDocument): void {
  walkContent(root, (node) => {
    if (node.type !== "topikComponent" || node.name !== "card") return;
    const href = node.props?.href;
    if (href !== undefined && validateTopikNavigationHref(href).length > 0) delete node.props!.href;
  });
}

function linkKind(node: TreeNode): TopikContentLinkKind | undefined {
  if (node.type === "link" || node.type === "linkReference") return "link";
  if (node.type === "topikComponent" && node.name === "card") return "card";
  return undefined;
}

function locationFields(node: TreeNode, file?: string): { file?: string; lines: number[] } {
  return { ...(file ? { file } : {}), lines: node.position ? [node.position.start.line] : [] };
}

function linkError(id: string): ValidationError {
  const message = topikLinkDiagnosticMessage(id);
  if (message === undefined) throw new TypeError("Unknown link diagnostic identifier");
  return { id, level: "error", message };
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isNetworkPathReference(value: string): boolean {
  const isPathSeparator = (character: string | undefined) =>
    character === "/" || character === "\\";
  return isPathSeparator(value[0]) && isPathSeparator(value[1]);
}

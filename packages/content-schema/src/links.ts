import type { Node, ValidationError } from "@markdoc/markdoc";
import { assignTopikHeadingIds, type TopikHeading } from "./headings";
import { parseTopikContent } from "./content";
import type { TopikContentDiagnostic } from "./diagnostics";

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
}

export function analyzeTopikContent(
  source: string,
  options: AnalyzeTopikContentOptions = {},
): AnalyzeTopikContentResult {
  const ast = parseTopikContent(source, { file: options.file, location: true });
  const headingNodes = nodesOfType(ast, "heading");
  const explicitIdNodes = new Map<string, Node[]>();

  for (const node of headingNodes) {
    const id = typeof node.attributes.id === "string" ? node.attributes.id : undefined;
    if (!id) continue;
    const nodes = explicitIdNodes.get(id) ?? [];
    nodes.push(node);
    explicitIdNodes.set(id, nodes);
  }

  const assignedHeadings = assignTopikHeadingIds(ast);
  const headings = assignedHeadings.map((heading, index) => ({
    ...heading,
    ...locationFields(headingNodes[index], options.file),
  }));
  const diagnostics: TopikContentDiagnostic[] = [];

  for (const [id, nodes] of explicitIdNodes) {
    for (const node of nodes.slice(1)) {
      diagnostics.push({
        id: "heading-id-duplicate",
        type: "heading",
        level: "error",
        message: `Explicit heading ID '${id}' is used more than once in this document.`,
        ...locationFields(node, options.file),
      });
    }
  }

  const links: TopikContentLink[] = [];
  for (const node of [ast, ...ast.walk()]) {
    const kind = linkKind(node);
    if (!kind) continue;
    const href = node.attributes.href;
    if (typeof href !== "string") continue;
    links.push({ href, kind, ...locationFields(node, options.file) });
  }

  return { diagnostics, headings, links };
}

export function validateTopikHref(value: unknown): ValidationError[] {
  if (typeof value !== "string") return [];
  if (value.length === 0) {
    return [linkError("link-href-empty", "Link target must not be empty.")];
  }
  if (value !== value.trim()) {
    return [linkError("link-url-invalid", "Link target must not have surrounding whitespace.")];
  }
  if (hasAsciiControl(value)) {
    return [linkError("link-url-invalid", "Link target must not contain control characters.")];
  }
  if (isNetworkPathReference(value)) {
    return [
      linkError(
        "link-url-protocol-relative",
        "Protocol-relative links are not supported; use an explicit http or https URL.",
      ),
    ];
  }

  const explicitScheme = SCHEME.exec(value)?.[1].toLowerCase();

  try {
    const parsed = new URL(value, TOPIK_BASE_URL);
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    if (!ALLOWED_SCHEMES.has(scheme)) {
      const unsafe = UNSAFE_SCHEMES.has(scheme);
      return [
        linkError(
          unsafe ? "link-scheme-unsafe" : "link-scheme-unsupported",
          `${unsafe ? "Unsafe" : "Unsupported"} link scheme '${scheme}:'.`,
        ),
      ];
    }
    if (!explicitScheme && parsed.origin !== TOPIK_BASE_URL.origin) {
      return [
        linkError(
          "link-url-protocol-relative",
          "Protocol-relative links are not supported; use an explicit http or https URL.",
        ),
      ];
    }
    if ((scheme === "http" || scheme === "https") && !parsed.hostname) {
      return [linkError("link-url-invalid", `Invalid ${scheme} URL.`)];
    }
    if ((scheme === "mailto" || scheme === "tel" || scheme === "asset") && !parsed.pathname) {
      return [linkError("link-url-invalid", `Invalid ${scheme} link.`)];
    }
    if (parsed.hash) decodeURIComponent(parsed.hash.slice(1));
  } catch {
    return [linkError("link-url-invalid", `Invalid link target '${value}'.`)];
  }

  return [];
}

function nodesOfType(ast: Node, type: string): Node[] {
  return [...ast.walk()].filter((node) => node.type === type);
}

function linkKind(node: Node): TopikContentLinkKind | undefined {
  if (node.type === "link") return "link";
  if (node.type === "tag" && node.tag === "card") return "card";
  return undefined;
}

function locationFields(node: Node, fallbackFile?: string): { file?: string; lines: number[] } {
  const file = node.location?.file ?? fallbackFile;
  const lines =
    node.lines.length > 0 ? node.lines : node.location ? [node.location.start.line] : [];
  return { ...(file ? { file } : {}), lines };
}

function linkError(id: string, message: string): ValidationError {
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

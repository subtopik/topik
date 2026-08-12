import type {
  AnalyzeTopikContentResult,
  TopikContentDiagnostic,
  TopikContentLink,
} from "@topik/content-schema";
import { topikLinkDiagnosticMessage } from "@topik/content-schema";
import type { LinkValidationPolicy } from "./shared";

const NON_PAGE_SCHEME = /^(?:asset|https?|mailto|tel):/i;
const LINK_BASE = "https://topik.local";

export interface WikiPageLinkAnalysis {
  analysis: AnalyzeTopikContentResult;
  sourcePath: string;
  slug: string;
}

export function validateWikiLinks(
  pages: WikiPageLinkAnalysis[],
  policy: LinkValidationPolicy,
  nonPageLinks: ReadonlySet<TopikContentLink> = new Set(),
): TopikContentDiagnostic[] {
  if (policy === "off") return [];

  const level = policy === "error" ? "error" : "warning";
  const pagesBySlug = new Map(pages.map((page) => [page.slug, page]));
  const diagnostics: TopikContentDiagnostic[] = [];

  for (const page of pages) {
    for (const link of page.analysis.links) {
      if (NON_PAGE_SCHEME.test(link.href)) continue;

      const target = resolveInternalTarget(link.href, page.sourcePath);
      if (!target) continue;
      const targetPage = pagesBySlug.get(target.slug);
      if (!targetPage) {
        if (nonPageLinks.has(link)) continue;
        diagnostics.push(linkDiagnostic("link-page-not-found", level, link));
        continue;
      }

      if (
        target.fragment &&
        !targetPage.analysis.headings.some((heading) => heading.id === target.fragment)
      ) {
        diagnostics.push(linkDiagnostic("link-fragment-not-found", level, link));
      }
    }
  }

  return diagnostics;
}

export function validateLocalFragments(
  analysis: AnalyzeTopikContentResult,
  policy: LinkValidationPolicy,
): TopikContentDiagnostic[] {
  if (policy === "off") return [];

  const level = policy === "error" ? "error" : "warning";
  const headingIds = new Set(analysis.headings.map((heading) => heading.id));
  const diagnostics: TopikContentDiagnostic[] = [];

  for (const link of analysis.links) {
    if (!link.href.startsWith("#") || link.href === "#") continue;
    const fragment = decodeFragment(link.href.slice(1));
    if (fragment && !headingIds.has(fragment)) {
      diagnostics.push(linkDiagnostic("link-fragment-not-found", level, link));
    }
  }

  return diagnostics;
}

function resolveInternalTarget(
  href: string,
  sourcePath: string,
): { fragment: string; slug: string } | undefined {
  let url: URL;
  try {
    url = new URL(href, `${LINK_BASE}/${sourcePath}`);
  } catch {
    return undefined;
  }
  if (url.origin !== LINK_BASE) return undefined;

  return {
    fragment: decodeFragment(url.hash.slice(1)),
    slug: decodePath(url.pathname),
  };
}

function decodeFragment(value: string): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodePath(pathname: string): string {
  const decoded = pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

  const normalized = decoded.replace(/\.(?:mdx?|markdown)$/i, "");
  if (normalized === "index") return "";
  return normalized.replace(/\/index$/, "");
}

function linkDiagnostic(
  id: string,
  level: "error" | "warning",
  link: TopikContentLink,
): TopikContentDiagnostic {
  const message = topikLinkDiagnosticMessage(id);
  if (message === undefined) throw new TypeError("Unknown link diagnostic identifier");
  return {
    id,
    type: link.kind,
    level,
    message,
    lines: link.lines,
    ...(link.file ? { file: link.file } : {}),
  };
}

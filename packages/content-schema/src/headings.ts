import type { Node } from "@markdoc/markdoc";
import GithubSlugger from "github-slugger";

export interface TopikHeading {
  id: string;
  level: number;
  title: string;
}

interface CollectedHeading {
  explicitId?: string;
  level: number;
  node: Node;
  title: string;
}

/**
 * Assign stable, document-scoped IDs to headings and return their metadata.
 *
 * Explicit Markdoc ID annotations take precedence. Generated IDs follow the
 * GitHub slug algorithm and account for duplicate and explicit IDs in the
 * same document.
 */
export function assignTopikHeadingIds(ast: Node): TopikHeading[] {
  const headings = collectHeadings(ast);
  const slugger = new GithubSlugger();

  // Reserve explicit IDs before generating any fallback IDs so an authored
  // anchor is never shadowed by an automatically generated heading.
  for (const heading of headings) {
    if (heading.explicitId) slugger.slug(heading.explicitId);
  }

  return headings.map((heading) => {
    const id = heading.explicitId ?? slugger.slug(heading.title);
    heading.node.attributes.id = id;
    return { id, level: heading.level, title: heading.title };
  });
}

function collectHeadings(ast: Node): CollectedHeading[] {
  const headings: CollectedHeading[] = [];

  walk(ast, (node) => {
    if (node.type !== "heading") return;

    const explicitId =
      typeof node.attributes.id === "string" && node.attributes.id.length > 0
        ? node.attributes.id
        : undefined;
    const level = typeof node.attributes.level === "number" ? node.attributes.level : 1;
    const title = plainText(node).trim().replace(/\s+/g, " ");
    headings.push({ explicitId, level, node, title });
  });

  return headings;
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function plainText(node: Node): string {
  if (node.type === "text" || node.type === "code") {
    return typeof node.attributes.content === "string" ? node.attributes.content : "";
  }

  return node.children.map(plainText).join("");
}

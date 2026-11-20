import type { Heading } from "mdast";
import GithubSlugger, { slug } from "github-slugger";
import type { AuthoredAttributeValue, ContentDocument, TreeNode } from "./model.js";
import { plainText, walkContent } from "./traversal.js";

/** Base anchor for headings whose text has no sluggable characters. */
const FALLBACK_HEADING_ID = "section";

export interface TopikHeading {
  id: string;
  level: number;
  title: string;
  /**
   * Present when the ID is generated from a title that other headings or accordions share. Such
   * an ID is numbered by occurrence (`details-1`), so adding or removing an earlier one with the
   * same title moves it to another target. Links should target an explicit ID instead.
   */
  positional?: true;
}

/** A link target in a document: a heading or an accordion. Both share one set of IDs. */
export interface TopikAnchor {
  id: string;
  kind: "heading" | "accordion";
  /** See {@link TopikHeading.positional}. */
  positional?: true;
}

/** @internal Whether a node receives an anchor ID. */
export function isAnchorNode(node: TreeNode): boolean {
  return node.type === "heading" || (node.type === "topikComponent" && node.name === "accordion");
}

/** Text of a title attribute; like heading text, interpolated variables contribute nothing. */
function titleText(value: AuthoredAttributeValue | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object")
    return value.segments
      .map((segment) => (segment.type === "literal" ? segment.value : ""))
      .join("");
  return "";
}

function explicitId(node: TreeNode): unknown {
  return node.type === "heading"
    ? (node as unknown as Heading).data?.topikId
    : (node.props?.id ?? undefined);
}

export function assignTopikHeadingIds(document: ContentDocument): TopikHeading[] {
  const nodes: TreeNode[] = [];
  walkContent(document, (node) => {
    if (isAnchorNode(node as TreeNode)) nodes.push(node as TreeNode);
  });
  return assignHeadingIds(nodes);
}

/** @internal Reuse headings and accordions collected by a bounded document index. */
export function assignHeadingIds(nodes: readonly TreeNode[]): TopikHeading[] {
  const headings: TopikHeading[] = [];
  for (const [index, anchor] of assignAnchorIds(nodes).entries()) {
    const node = nodes[index];
    if (anchor.kind !== "heading") continue;
    headings.push({
      id: anchor.id,
      level: (node as unknown as Heading).depth,
      title: plainText(node).trim().replace(/\s+/g, " "),
      ...(anchor.positional ? { positional: true as const } : {}),
    });
  }
  return headings;
}

/**
 * @internal Give each heading and accordion, in document order, its explicit ID or a generated
 * one. Generated IDs follow GitHub: the slug of the title, numbered by occurrence, skipping
 * explicit IDs. Headings keep the ID in `data.hProperties.id`, accordions in `data.topikAnchorId`.
 */
export function assignAnchorIds(nodes: readonly TreeNode[]): TopikAnchor[] {
  const slugger = new GithubSlugger();
  const explicitIds = new Set<string>();
  for (const node of nodes) {
    const id = explicitId(node);
    if (typeof id === "string") explicitIds.add(id);
  }
  const titles = nodes.map((node) =>
    (node.type === "heading" ? plainText(node) : titleText(node.props?.title))
      .trim()
      .replace(/\s+/g, " "),
  );
  // Generated IDs share a base when their titles slug alike, such as `C++` and `C#`.
  const bases = titles.map((title) => slug(title) || FALLBACK_HEADING_ID);
  const generatedBases = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (typeof explicitId(node) !== "string")
      generatedBases.set(bases[index], (generatedBases.get(bases[index]) ?? 0) + 1);
  });
  return nodes.map((node, index) => {
    const explicit = explicitId(node);
    let id = typeof explicit === "string" ? explicit : "";
    if (typeof explicit !== "string") {
      // Explicit anchors retain their spelling; only generated IDs are slugified.
      // Titles without sluggable text share a fallback so no ID is ever empty.
      const base = slug(titles[index]) === "" ? FALLBACK_HEADING_ID : titles[index];
      do {
        id = slugger.slug(base);
      } while (explicitIds.has(id));
    }
    const kind = node.type === "heading" ? "heading" : "accordion";
    if (kind === "heading") {
      const heading = node as unknown as Heading;
      heading.data = { ...heading.data, hProperties: { id } };
    } else
      (node as TreeNode & { data?: Record<string, unknown> }).data = {
        ...(node as TreeNode & { data?: Record<string, unknown> }).data,
        topikAnchorId: id,
      };
    return {
      id,
      kind,
      ...(typeof explicit !== "string" && generatedBases.get(bases[index])! > 1
        ? { positional: true as const }
        : {}),
    };
  });
}

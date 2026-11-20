import type { ContentDocument, TreeNode } from "./model.js";
import type { Association } from "mdast";
import { referenceIdentifier, referenceSourceLabel } from "./document-index.js";

/**
 * Footnote labels are document-wide and case-insensitive, like reference labels. A definition is
 * written once at the end of the document, wherever it was authored, so its position carries no
 * meaning: the writer and the meaning check both use the canonical order from this module.
 */
export function footnoteKey(node: TreeNode): string {
  return referenceIdentifier(String((node as TreeNode & { identifier?: string }).identifier));
}

export interface FootnoteProblem {
  node: TreeNode;
  id: string;
  message: string;
}

/** Visit nodes in document order, including every conditional branch. */
function visit(node: TreeNode, callback: (node: TreeNode, parent?: TreeNode) => void): void {
  function walk(current: TreeNode, parent?: TreeNode): void {
    callback(current, parent);
    for (const child of current.children ?? []) walk(child, current);
  }
  walk(node);
}

/** Labels in order of their first reference across the authored document. */
function referenceOrder(document: TreeNode): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  visit(document, (node) => {
    if (node.type !== "footnoteReference") return;
    const key = footnoteKey(node);
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  });
  return order;
}

/** Footnote anchors are `fn:N`, `fnref:N` and `fnref:N:K`; explicit heading IDs avoid them. */
const reservedAnchor = /^fn(?:ref)?:/u;

/** Placement, uniqueness and reference rules; shapes are checked by the node grammar. */
export function footnoteProblems(document: ContentDocument): FootnoteProblem[] {
  const problems: FootnoteProblem[] = [];
  const definitions = new Map<string, TreeNode>();
  const references = new Set<string>();
  const root = document as TreeNode;
  function insideDefinitionOrLink(ancestors: readonly TreeNode[]): "definition" | "link" | null {
    for (const ancestor of ancestors) {
      if (ancestor.type === "footnoteDefinition") return "definition";
      if (ancestor.type === "link" || ancestor.type === "linkReference") return "link";
    }
    return null;
  }
  function walk(node: TreeNode, ancestors: readonly TreeNode[]): void {
    if (node.type === "footnoteDefinition") {
      if (ancestors.at(-1) !== root)
        problems.push({
          node,
          id: "topik-footnote-placement",
          message: "Footnote definitions belong at the top level of the document",
        });
      const key = footnoteKey(node);
      if (definitions.has(key))
        problems.push({
          node,
          id: "topik-footnote-duplicate",
          message: "Footnote label is defined more than once",
        });
      else definitions.set(key, node);
    }
    if (node.type === "heading") {
      const id = (node as TreeNode & { data?: { topikId?: unknown } }).data?.topikId;
      if (typeof id === "string" && reservedAnchor.test(id))
        problems.push({
          node,
          id: "topik-heading-id-reserved",
          message: "Explicit heading IDs cannot start with fn: or fnref:",
        });
    }
    if (
      (node.type === "heading" || node.type === "definition" || node.type === "topikConditional") &&
      ancestors.some((ancestor) => ancestor.type === "footnoteDefinition")
    )
      problems.push({
        node,
        id: "topik-footnote-content",
        message: "Footnote definitions cannot contain headings, link definitions or conditionals",
      });
    if (node.type === "footnoteReference") {
      references.add(footnoteKey(node));
      // A table row splits at every unescaped `|` before inline parsing, and escaping the pipe
      // gives a different label, so a reference in a cell has no faithful spelling for it.
      if (
        ancestors.some((ancestor) => ancestor.type === "tableCell") &&
        referenceSourceLabel(node as unknown as Association)
          .replace(/\\[\s\S]/gu, "")
          .includes("|")
      )
        problems.push({
          node,
          id: "topik-reference-label",
          message: "Footnote references in table cells cannot have a label with an unescaped |",
        });
      const container = insideDefinitionOrLink(ancestors);
      if (container === "definition")
        problems.push({
          node,
          id: "topik-footnote-nested",
          message: "Footnote definitions cannot contain footnote references",
        });
      else if (container === "link")
        problems.push({
          node,
          id: "topik-footnote-placement",
          message: "Links cannot contain footnote references",
        });
      // An explanation appears only once the reader answers, so a reference inside it would
      // be numbered, and linked from its note, before it exists on the page.
      else if (
        ancestors.some(
          (ancestor) => ancestor.type === "topikComponent" && ancestor.name === "explanation",
        )
      )
        problems.push({
          node,
          id: "topik-footnote-placement",
          message: "Quiz explanations cannot contain footnote references",
        });
    }
    for (const child of node.children ?? []) walk(child, [...ancestors, node]);
  }
  walk(root, []);
  visit(root, (node) => {
    if (node.type === "footnoteReference" && !definitions.has(footnoteKey(node)))
      problems.push({
        node,
        id: "topik-footnote-missing",
        message: "Footnote reference has no definition",
      });
  });
  for (const [key, node] of definitions)
    if (!references.has(key))
      problems.push({
        node,
        id: "topik-footnote-unreferenced",
        message: "Footnote definition is never referenced",
      });
  return problems;
}

/**
 * Move every top-level footnote definition to the end of the document, in the order of first
 * reference. Definitions that no reference reaches keep their relative order after the others.
 * Returns the input when it has no definitions, otherwise a shallow copy of the root.
 */
export function canonicalizeFootnotes<T extends ContentDocument>(document: T): T {
  const children = (document as TreeNode).children ?? [];
  const definitions = children.filter((child) => child.type === "footnoteDefinition");
  if (!definitions.length) return document;
  const rank = new Map(referenceOrder(document as TreeNode).map((key, index) => [key, index]));
  const ordered = definitions
    .map((node, index) => ({ node, index, rank: rank.get(footnoteKey(node)) ?? Infinity }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ node }) => node);
  return {
    ...document,
    children: [...children.filter((child) => child.type !== "footnoteDefinition"), ...ordered],
  } as T;
}

export interface FootnoteNumbering {
  /** Number of each label, in order of first reference. */
  numbers: Map<string, number>;
  /** Back-reference anchors of each label, one per reference, in document order. */
  backrefs: Map<string, string[]>;
  /** Anchor of each reference node. */
  anchors: WeakMap<TreeNode, string>;
}

export function footnoteAnchor(number: number): string {
  return `fn:${number}`;
}

/**
 * Number footnotes of an evaluated document by their first shown reference. References inside a
 * subtree the renderer drops, such as a component with `render: false`, are not shown and so are
 * neither numbered nor linked back to.
 */
export function numberFootnotes(
  document: ContentDocument,
  hidden: (node: TreeNode) => boolean = () => false,
): FootnoteNumbering {
  const numbers = new Map<string, number>();
  const backrefs = new Map<string, string[]>();
  const anchors = new WeakMap<TreeNode, string>();
  function walk(node: TreeNode): void {
    if (hidden(node)) return;
    if (node.type !== "footnoteReference") {
      for (const child of node.children ?? []) walk(child);
      return;
    }
    const key = footnoteKey(node);
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    const number = numbers.get(key)!;
    const list = backrefs.get(key) ?? [];
    const anchor = list.length === 0 ? `fnref:${number}` : `fnref:${number}:${list.length + 1}`;
    list.push(anchor);
    backrefs.set(key, list);
    anchors.set(node, anchor);
  }
  walk(document as TreeNode);
  return { numbers, backrefs, anchors };
}

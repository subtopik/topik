import type { TreeNode } from "./model.js";
import type { Registry } from "./registry.js";

export const blockTypes = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "code",
  "topikCodeTemplate",
  "topikCodePresentation",
  "table",
  "thematicBreak",
  "definition",
  "footnoteDefinition",
  "topikConditional",
]);
export const inlineTypes = new Set([
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "break",
  "link",
  "image",
  "linkReference",
  "imageReference",
  "footnoteReference",
  "topikVariable",
]);
export const inlineParentTypes = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
]);
export const parentTypes = new Set([
  ...inlineParentTypes,
  "root",
  "blockquote",
  "list",
  "listItem",
  "footnoteDefinition",
  "table",
  "tableRow",
  "topikComponent",
  "topikConditional",
  "topikBranch",
  "topikCodePresentation",
]);
export const nodeTypes = new Set([...parentTypes, ...blockTypes, ...inlineTypes, "yaml"]);

/** Parsed Markdown that Topik does not model, reported by the node itself rather than its parent. */
export function isUnsupportedNode(node: TreeNode): boolean {
  return typeof node.type === "string" && !nodeTypes.has(node.type);
}

export function isContentKind(
  node: TreeNode,
  kind: "inline" | "block",
  registry: Registry,
): boolean {
  if (node.type !== "topikComponent")
    return (kind === "inline" ? inlineTypes : blockTypes).has(node.type);
  return (
    typeof node.name === "string" &&
    Object.hasOwn(registry, node.name) &&
    registry[node.name].kind === kind
  );
}

/** A supported node of the wrong kind; unsupported nodes are reported at their own position. */
export function isMisplacedContent(
  node: TreeNode,
  kind: "inline" | "block",
  registry: Registry,
): boolean {
  return !isUnsupportedNode(node) && !isContentKind(node, kind, registry);
}

export function isInlineParent(node: TreeNode, registry: Registry): boolean {
  return (
    inlineParentTypes.has(node.type) ||
    (node.type === "topikComponent" && isContentKind(node, "inline", registry))
  );
}

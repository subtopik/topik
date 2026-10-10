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
  "table",
  "tableRow",
  "topikComponent",
  "topikConditional",
  "topikBranch",
  "topikCodePresentation",
]);
export const nodeTypes = new Set([...parentTypes, ...blockTypes, ...inlineTypes, "yaml"]);

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

export function isInlineParent(node: TreeNode, registry: Registry): boolean {
  return (
    inlineParentTypes.has(node.type) ||
    (node.type === "topikComponent" && isContentKind(node, "inline", registry))
  );
}

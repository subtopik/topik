import type { TreeNode } from "./model.js";
import { assertDataLimits, assertTreeLimits } from "./limits.js";

export function walkContent(
  node: TreeNode,
  visit: (node: TreeNode, path: readonly number[]) => void,
  path: readonly number[] = [],
): void {
  assertDataLimits(node, { plain: true });
  assertTreeLimits(node);
  function walk(node: TreeNode, path: readonly number[]): void {
    visit(node, path);
    for (const [index, child] of (node.children ?? []).entries()) walk(child, [...path, index]);
  }
  walk(node, path);
}

export function plainText(node: TreeNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  if (node.type === "image" || node.type === "imageReference")
    return (node as TreeNode & { alt?: string }).alt ?? "";
  if (node.type === "break") return "\n";
  return (node.children ?? []).map(plainText).join("");
}

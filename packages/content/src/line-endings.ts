import type { TreeNode } from "./model.js";

/** Normalize source syntax, leaving entity-decoded characters and original locations distinct. */
export function normalizeLineEndings(source: string): {
  source: string;
  restorePositions: (root: TreeNode) => void;
} {
  const crlfOffsets: number[] = [];
  const normalized = source.replace(/\r\n?/g, (ending, offset: number) => {
    if (ending.length === 2) crlfOffsets.push(offset - crlfOffsets.length);
    return "\n";
  });

  function originalOffset(offset: number): number {
    let low = 0;
    let high = crlfOffsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (crlfOffsets[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return offset + low;
  }

  function restorePositions(node: TreeNode): void {
    if (crlfOffsets.length === 0) return;
    const position = node.position;
    if (position) {
      // Points can be shared between nodes. Replace them rather than applying
      // the correction more than once to the same point object.
      node.position = {
        start: {
          ...position.start,
          ...(position.start.offset === undefined
            ? {}
            : { offset: originalOffset(position.start.offset) }),
        },
        end: {
          ...position.end,
          ...(position.end.offset === undefined
            ? {}
            : { offset: originalOffset(position.end.offset) }),
        },
      };
    }
    for (const child of node.children ?? []) restorePositions(child);
  }

  return { source: normalized, restorePositions };
}

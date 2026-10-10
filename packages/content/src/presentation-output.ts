import type { ContentDocument, TreeNode } from "./model.js";
import { CONTENT_LIMITS, ContentLimitError } from "./limits.js";
import { normalizeCodePresentationOptions } from "./code-presentation.js";

/**
 * Reserve a conservative serialization budget before allocating reader rows.
 * Each text unit can expand to six HTML units; each row reserves 768 units for
 * its number, diff meaning, state classes and surrounding elements. Each
 * independent collapse region reserves another 768 units for its visible control. Syntax
 * highlighting is optional and must fall back when its tokens exceed a budget.
 */
export function assertCodePresentationOutputLimit(document: ContentDocument): void {
  let length = 0;
  const stack: TreeNode[] = [document as TreeNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "topikCodePresentation") {
      const child = node.children?.[0];
      let rows = 1;
      let payloadLength = 0;
      function measure(value: string): void {
        payloadLength += value.length;
        for (let index = 0; index < value.length; index++)
          if (value.charCodeAt(index) === 10) rows++;
      }
      if (child?.type === "code") measure(child.value ?? "");
      else
        for (const segment of child?.template?.segments ?? [])
          if (segment.type === "literal") measure(segment.value);
      const collapseRegions = node.options?.collapse
        ? normalizeCodePresentationOptions(node.options, rows).collapse!.length
        : 0;
      length += payloadLength * 6 + (rows + collapseRegions) * 768 + 4096;
      length += (child?.lang?.length ?? 0) * 6;
      length += ((node.options?.title?.length ?? 0) + (node.options?.filename?.length ?? 0)) * 6;
      if (length > CONTENT_LIMITS.presentationOutputLength)
        throw new ContentLimitError("Presented code exceeds the generated markup limit");
    }
    for (const child of node.children ?? []) stack.push(child);
  }
}

import { defaultHandlers, type Handle, type Options } from "mdast-util-to-markdown";
import type { TreeNode } from "./model.js";

/** Choose delimiters before writing so handlers and their lookahead agree. */
export function markWriterExtension(root: TreeNode): NonNullable<Options["extensions"]>[number] {
  const markers = new WeakMap<TreeNode, "*" | "_">();
  function walk(
    node: TreeNode,
    active: Partial<Record<"emphasis" | "strong", "*" | "_">> = {},
  ): void {
    let previous: "*" | "_" | undefined;
    for (const child of node.children ?? []) {
      const kind = child.type === "emphasis" || child.type === "strong" ? child.type : undefined;
      // Adjacent siblings need distinct delimiters too: *one**two* would
      // introduce literal asterisks instead of preserving two emphasis nodes.
      const neighbor =
        previous ??
        (kind ? active[kind] : undefined) ??
        (kind === "emphasis" && node.type === "strong" && node.children?.length === 1
          ? markers.get(node)
          : undefined);
      const marker = neighbor === "*" ? "_" : "*";
      if (kind) markers.set(child, marker);
      walk(child, kind ? { ...active, [kind]: marker } : active);
      previous = kind ? marker : undefined;
    }
  }
  walk(root);

  function handler(kind: "emphasis" | "strong"): Handle {
    // Newer mdast-util-to-markdown versions serialize marks through this
    // callback instead of calling the handler. Keep that metadata on our
    // wrapper so their phrasing writer does not recurse into the same node.
    const attention = (
      defaultHandlers[kind] as Handle & {
        attention?: (
          node: Parameters<Handle>[0],
          state: Parameters<Handle>[2],
        ) => {
          construct: string;
          markers: string[];
          sizes: number[];
        };
      }
    ).attention;
    const handle: Handle = (node, parent, state, info) => {
      const previous = state.options[kind];
      state.options[kind] = markers.get(node as TreeNode) ?? "*";
      try {
        return defaultHandlers[kind](node, parent, state, info);
      } finally {
        state.options[kind] = previous;
      }
    };
    const peek: Handle = (node) => markers.get(node as TreeNode) ?? "*";
    return Object.assign(handle, {
      peek,
      ...(attention && {
        attention: (node: Parameters<Handle>[0], state: Parameters<Handle>[2]) => {
          const previous = state.options[kind];
          state.options[kind] = markers.get(node as TreeNode) ?? "*";
          try {
            return attention(node, state);
          } finally {
            state.options[kind] = previous;
          }
        },
      }),
    });
  }
  return { handlers: { emphasis: handler("emphasis"), strong: handler("strong") } };
}

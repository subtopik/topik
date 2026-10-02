import type { Association, ImageReference, LinkReference } from "mdast";
import type { Handle, Options, State } from "mdast-util-to-markdown";
import { referenceSourceLabel } from "./document-index.js";

/** Escapes and entities are part of reference identity, not decoded Markdown text. */
export function referenceLabel(node: Association, state: State): string {
  const value = referenceSourceLabel(node);
  // Tables remove this escape before parsing inline references.
  return state.stack.includes("tableCell") ? value.replaceAll("|", "\\|") : value;
}

export function referenceWriterExtension(): NonNullable<Options["extensions"]>[number] {
  const reference: Handle = (untyped, _parent, state, info) => {
    const node = untyped as ImageReference | LinkReference;
    const exit = state.enter(node.type);
    const labelExit = state.enter("label");
    const tracker = state.createTracker(info);
    const prefix = tracker.move(node.type === "imageReference" ? "![" : "[");
    const context = { before: prefix, after: "]", ...tracker.current() };
    const text =
      node.type === "imageReference"
        ? state.safe(node.alt ?? "", context)
        : state.containerPhrasing(node, context);
    labelExit();
    const label = referenceLabel(node, state);
    exit();
    const suffix =
      node.referenceType === "full" || !text || text !== label
        ? `[${label}]`
        : node.referenceType === "collapsed"
          ? "[]"
          : "";
    return `${prefix}${text}]${suffix}`;
  };
  const linkReference: Handle = Object.assign(reference.bind(null), { peek: () => "[" });
  const imageReference: Handle = Object.assign(reference.bind(null), { peek: () => "!" });
  return { handlers: { linkReference, imageReference } };
}

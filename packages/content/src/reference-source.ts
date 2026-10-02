import type { Extension } from "mdast-util-from-markdown";
import type { Node } from "mdast";
import type { DocumentIndex } from "./document-index.js";

type Resource = Node & { url: string };

// Source spelling is parser evidence, not part of the portable authoring tree.
// A WeakMap keeps it out of serialization and allows parsed documents to be freed.
const references = new WeakMap<object, string>();

export function referenceSourceExtension(): Extension {
  return {
    enter: {
      resourceDestinationString(token) {
        references.set(this.stack.at(-1)!, this.sliceSerialize(token));
        this.buffer();
      },
      definitionDestinationString(token) {
        references.set(this.stack.at(-1)!, this.sliceSerialize(token));
        this.buffer();
      },
    },
  };
}

function exactReference(node: Resource, source: string): string | undefined {
  const recorded = references.get(node);
  if (recorded !== undefined) return recorded;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return;
  const spelling = source.slice(start, end);
  // Explicit angle links have no resource destination token.
  if (spelling === `<${node.url}>`) return node.url;
  if (node.url.startsWith("mailto:") && spelling === `<${node.url.slice(7)}>`) return node.url;
}

function sourceKey(node: Node): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) return `${node.type}:${start}:${end}`;
}

/** Recover copied nodes' evidence once, using the same parser and original source positions. */
export function createReferenceSourceLookup(
  source: string,
  reparse: () => DocumentIndex,
): (node: Resource) => string {
  let recovered: Map<string, { url: string; reference: string }> | undefined;
  return (node) => {
    const recorded = exactReference(node, source);
    if (recorded !== undefined) return recorded;
    const key = sourceKey(node);
    if (key === undefined) return "";
    if (recovered === undefined) {
      recovered = new Map();
      try {
        for (const { node: original } of reparse().entries) {
          if (!("url" in original) || typeof original.url !== "string") continue;
          const key = sourceKey(original as Node);
          const reference = exactReference(original as Resource, source);
          if (key !== undefined && reference !== undefined)
            recovered.set(key, { url: original.url, reference });
        }
      } catch {
        // Invalid or unsupported source cannot establish destination evidence.
      }
    }
    const match = recovered.get(key);
    return match?.url === node.url ? match.reference : "";
  };
}

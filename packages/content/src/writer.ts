import { tagOptions } from "./tag-options.js";
import type { Root } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { frontmatterToMarkdown } from "mdast-util-frontmatter";
import { tagToMarkdown } from "@topik/remark-tags";
import type { Component, ContentDocument, TreeNode } from "./model.js";
import { components, type Registry } from "./registry.js";
import { writeExpression } from "./expressions.js";
import { validateDocument } from "./validation.js";
import { FORMAT_VERSION, parseDocumentTree } from "./parser.js";
import { sameDocumentMeaning } from "./document-meaning.js";
import { gfmToMarkdown } from "./gfm.js";
import { markWriterExtension } from "./markdown-marks.js";
import { headingIdToMarkdown } from "./heading-ids.js";
import { resourceWriterExtension } from "./resource-writer.js";
import { referenceWriterExtension } from "./reference-writer.js";
import { boundaryWhitespaceWriterExtension } from "./whitespace-writer.js";

function asTags(root: ContentDocument, registry: Registry): Root {
  const cloned = structuredClone(root) as TreeNode;
  function walk(node: TreeNode): void {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      walk(child);
      if (child.type === "topikVariable")
        return { type: "tagVariable", path: (child.path as string[]).join(".") };
      if (child.type === "topikBranch")
        return {
          type: "tagBranch",
          condition: child.condition === null ? null : writeExpression(child.condition as never),
          children: child.children,
        };
      if (child.type === "topikConditional")
        return { type: "tagConditional", children: child.children };
      if (child.type !== "topikComponent") return child;
      const component = child as TreeNode & Component;
      const definition = registry[component.name];
      return {
        type:
          definition.kind === "inline"
            ? "tagText"
            : definition.children === "none" ||
                (definition.selfClosing && component.children.length === 0)
              ? "tagLeaf"
              : "tagContainer",
        name: component.name,
        attributes: component.props,
        children: component.children,
      };
    });
  }
  walk(cloned);
  return cloned as Root;
}

export function writeDocument(
  document: ContentDocument,
  registry: Registry = components,
  formatVersion = FORMAT_VERSION,
): string {
  const written = serializeDocument(document, registry, formatVersion);
  const parsed = parseDocumentTree(written, registry, formatVersion);
  if (
    !parsed.document ||
    parsed.diagnostics.length ||
    !sameDocumentMeaning(document, parsed.document)
  )
    throw new Error("Content cannot be serialized without changing its meaning");
  return written;
}

/** @internal Source operations reuse their output admission parse for the meaning check. */
export function serializeDocument(
  document: ContentDocument,
  registry: Registry = components,
  formatVersion = FORMAT_VERSION,
): string {
  if (formatVersion !== FORMAT_VERSION)
    throw new Error(`Unsupported format version ${formatVersion}`);
  const errors = validateDocument(document, registry);
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  const tree = asTags(document, registry);
  return toMarkdown(tree, {
    extensions: [
      gfmToMarkdown(),
      markWriterExtension(tree as TreeNode),
      frontmatterToMarkdown(),
      tagToMarkdown(
        Object.fromEntries(
          Object.entries(registry).map(([name, definition]) => [name, { kind: definition.kind }]),
        ),
        tagOptions(registry),
      ),
      resourceWriterExtension(),
      referenceWriterExtension(),
      boundaryWhitespaceWriterExtension() as never,
      headingIdToMarkdown(),
    ],
    bullet: "-",
    fences: true,
  });
}

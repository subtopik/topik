import Markdoc, { type Node, type RenderableTreeNodes, type Schema } from "@markdoc/markdoc";

function renderFence(node: Node, config: Parameters<NonNullable<Schema["transform"]>>[1]) {
  const attributes = node.transformAttributes(config);
  const content = String(node.attributes.content ?? "");
  const language = typeof node.attributes.language === "string" ? node.attributes.language : "";
  const component = language === "mermaid" ? "TopikMermaid" : "TopikCodeBlock";

  return new Markdoc.Tag(component, { ...attributes, content, language }, []);
}

function renderCode(node: Node, config: Parameters<NonNullable<Schema["transform"]>>[1]) {
  const attributes = node.transformAttributes(config);
  const content = String(node.attributes.content ?? "");
  return new Markdoc.Tag("TopikInlineCode", attributes, [content]);
}

export const topikNodeSchemas = {
  code: {
    render: "TopikInlineCode",
    attributes: {
      content: { type: String, render: false, required: true },
    },
    transform: renderCode,
  },
  fence: {
    render: "TopikCodeBlock",
    attributes: {
      content: { type: String, render: false, required: true },
      language: { type: String, render: false },
      process: { type: Boolean, render: false, default: true },
    },
    transform: renderFence,
  },
  image: {
    render: "TopikImage",
    attributes: {
      src: { type: String, required: true },
      alt: { type: String },
      title: { type: String },
    },
  },
  link: {
    render: "TopikLink",
    children: ["strong", "em", "s", "code", "text", "tag"],
    attributes: {
      href: { type: String, required: true },
      title: { type: String },
    },
  },
  table: {
    render: "TopikTable",
  },
  tr: {
    render: "TopikTableRow",
    children: ["th", "td"],
  },
  td: {
    render: "TopikTableCell",
    children: [
      "inline",
      "heading",
      "paragraph",
      "image",
      "table",
      "tag",
      "fence",
      "blockquote",
      "list",
      "hr",
    ],
    attributes: {
      align: { type: String },
      colspan: { type: Number, render: "colSpan" },
      rowspan: { type: Number, render: "rowSpan" },
    },
  },
  th: {
    render: "TopikTableHeader",
    attributes: {
      width: { type: String },
      align: { type: String },
      colspan: { type: Number, render: "colSpan" },
      rowspan: { type: Number, render: "rowSpan" },
    },
  },
} satisfies Record<string, Schema>;

export function renderPlainTextChildren(
  node: Node,
  config: Parameters<NonNullable<Schema["transform"]>>[1],
): RenderableTreeNodes {
  return node.transformChildren(config);
}

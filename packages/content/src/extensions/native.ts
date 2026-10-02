import type { TopikComponentDefinition } from "../registry.js";

// These catalog names are represented by ordinary mdast nodes, not by extra
// authored {% ... %} tags. The renderer maps them to the same Topik components.
export const nativeComponents = {
  codeBlock: {
    name: "codeBlock",
    render: "TopikCodeBlock",
    kind: "block",
    description: "A fenced code block with an optional language.",
    attributes: { language: { type: "string", description: "Code language identifier." } },
  },
  inlineCode: {
    name: "inlineCode",
    render: "TopikInlineCode",
    kind: "inline",
    description: "Inline code text.",
  },
  image: {
    name: "image",
    render: "TopikImage",
    kind: "block",
    description: "Markdown image rendered through Topik asset resolution.",
    attributes: {
      src: {
        type: "string",
        required: true,
        description: "Image source URL.",
        assetReference: { slot: "image.src", role: "image" },
      },
      alt: { type: "string", description: "Accessible alternative text." },
      title: { type: "string", description: "Optional image title." },
    },
  },
  link: {
    name: "link",
    render: "TopikLink",
    kind: "inline",
    description: "Markdown link with optional application-level navigation interception.",
    attributes: {
      href: {
        type: "string",
        required: true,
        description: "Link target URL.",
        assetReference: { slot: "link.href", role: "download", conditional: "proven-download" },
      },
      title: { type: "string", description: "Optional link title." },
    },
  },
  mermaid: {
    name: "mermaid",
    render: "TopikMermaid",
    kind: "block",
    description: "Mermaid diagram rendered from a fenced mermaid code block.",
    attributes: {
      content: { type: "string", required: true, description: "Mermaid diagram source." },
    },
  },
  table: {
    name: "table",
    render: "TopikTable",
    kind: "block",
    description: "Markdown table.",
  },
  tableRow: {
    name: "tableRow",
    render: "TopikTableRow",
    kind: "block",
    description: "A row inside a Markdown table.",
  },
  tableCell: {
    name: "tableCell",
    render: "TopikTableCell",
    kind: "block",
    description: "A cell inside a Markdown table.",
  },
  tableHeader: {
    name: "tableHeader",
    render: "TopikTableHeader",
    kind: "block",
    description: "A header cell inside a Markdown table.",
  },
} as const satisfies Record<string, TopikComponentDefinition>;

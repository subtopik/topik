import type { ComponentDefinition } from "../registry.js";

export const cardDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikCard",
  description: "A card, standing alone or as a cell of columns.",
  attributes: {
    title: { type: "string", required: true, description: "Card title." },
    href: { type: "string", description: "Optional target URL." },
    icon: { type: "string", description: "Optional icon identifier." },
  },
  children: "blocks",
  selfClosing: true,
};

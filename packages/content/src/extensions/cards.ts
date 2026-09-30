import type { ComponentDefinition } from "../registry.js";

export const cardGridDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikCardGrid",
  description: "Responsive grid of card links or summary cards.",
  attributes: {
    columns: {
      type: "number",
      min: 1,
      max: 4,
      integer: true,
      description: "Preferred number of columns, from 1 to 4.",
    },
  },
  children: { components: ["card"] },
};

export const cardDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikCard",
  description: "A card within a card grid.",
  attributes: {
    title: { type: "string", required: true, description: "Card title." },
    href: { type: "string", description: "Optional target URL." },
    icon: { type: "string", description: "Optional icon identifier." },
  },
  children: "blocks",
  selfClosing: true,
};

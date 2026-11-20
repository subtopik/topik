import type { ComponentDefinition } from "../registry.js";

export const columnsDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikColumns",
  description:
    "Side-by-side cells that flow into rows and stack on narrow screens; each cell is a card or a column.",
  attributes: {
    count: {
      type: "number",
      min: 1,
      max: 4,
      integer: true,
      default: 2,
      description: "Number of columns, from 1 to 4.",
    },
  },
  children: { components: ["card", "column"], min: 1 },
};

export const columnDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikColumn",
  description: "A cell of columns holding any block content.",
  attributes: {},
  children: "blocks",
  allowedParents: ["columns"],
};

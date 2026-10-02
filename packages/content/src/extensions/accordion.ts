import type { ComponentDefinition } from "../registry.js";

export const accordionDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikAccordion",
  description: "A single disclosure section with a required title.",
  attributes: {
    title: { type: "string", required: true, description: "Accordion title." },
    open: { type: "boolean", description: "Whether the accordion is expanded by default." },
  },
  children: "blocks",
};

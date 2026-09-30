import type { ComponentDefinition } from "../registry.js";

export const calloutDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikCallout",
  description: "Highlighted contextual content such as a note, tip, warning, or danger message.",
  attributes: {
    variant: { type: "enum", values: ["info", "tip", "warning", "danger"], default: "info" },
    title: { type: "string" },
  },
  children: "blocks",
};

import type { ComponentDefinition } from "../registry.js";

export const badgeDefinition: ComponentDefinition = {
  kind: "inline",
  render: "TopikBadge",
  description: "Small inline status or metadata label.",
  attributes: {
    variant: {
      type: "enum",
      values: ["neutral", "info", "success", "warning", "danger"],
      default: "neutral",
      description: "Badge color/semantic variant.",
    },
  },
  children: "inline",
};

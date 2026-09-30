import type { ComponentDefinition } from "../registry.js";

export const tabsDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikTabs",
  description: "A tab set containing one or more tab panels.",
  attributes: {},
  children: { components: ["tab"], min: 1 },
};

export const tabDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikTab",
  description: "A tab panel inside a tabs component.",
  attributes: { title: { type: "string", required: true, description: "Visible tab label." } },
  children: "blocks",
  allowedParents: ["tabs"],
};

import type { ComponentDefinition } from "../registry.js";

export const stepsDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikSteps",
  description: "Ordered instructional steps.",
  attributes: {},
  children: { components: ["step"], min: 1 },
};

export const stepDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikStep",
  description: "One step inside a steps component.",
  attributes: { title: { type: "string", description: "Optional step heading." } },
  children: "blocks",
  allowedParents: ["steps"],
};

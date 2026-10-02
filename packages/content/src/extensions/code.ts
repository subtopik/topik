import type { ComponentDefinition } from "../registry.js";

export const codeGroupDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikCodeGroup",
  description: "A set of labeled code tabs.",
  attributes: {},
  children: { components: ["codeTab"], min: 1 },
};

export const codeTabDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikCodeTab",
  description: "A labeled code example inside a code group.",
  attributes: {
    title: { type: "string", required: true, description: "Visible code tab label." },
    icon: { type: "string", description: "Optional icon identifier." },
  },
  children: { nodes: ["code"], min: 1 },
  allowedParents: ["codeGroup"],
};

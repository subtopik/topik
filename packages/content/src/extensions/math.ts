import type { ComponentDefinition } from "../registry.js";

export const mathDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikMath",
  description: "Block math expression.",
  attributes: { content: { type: "string", required: true, description: "Math source." } },
  children: "none",
};

export const mathInlineDefinition: ComponentDefinition = {
  kind: "inline",
  render: "TopikMathInline",
  description: "Inline math expression.",
  attributes: { content: { type: "string", required: true, description: "Math source." } },
  children: "none",
};

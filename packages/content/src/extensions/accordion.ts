import type { AuthoredAttributeValue, Component } from "../model.js";
import type { ComponentDefinition, ValidationIssue } from "../registry.js";
import { validId } from "../heading-ids.js";

function validateAccordion(
  _component: Component,
  props: Record<string, AuthoredAttributeValue>,
): ValidationIssue[] {
  const id = props.id;
  return typeof id === "string" && !validId.test(id)
    ? [
        {
          id: "topik-accordion-id",
          message: "Accordion IDs use letters, digits, '_', '.', ':' and '-'",
          attribute: "id",
        },
      ]
    : [];
}

export const accordionDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikAccordion",
  description: "A single disclosure section with a required title.",
  attributes: {
    title: { type: "string", required: true, description: "Accordion title." },
    open: { type: "boolean", description: "Whether the accordion is expanded by default." },
    id: {
      type: "string",
      description:
        "Stable link target. Without it, the ID is generated from the title, like a heading's.",
    },
  },
  children: "blocks",
  validate: validateAccordion,
};

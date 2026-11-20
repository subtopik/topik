import type { Component } from "../model.js";
import type { ComponentDefinition, ValidationIssue } from "../registry.js";

/** A key needs a name: text of only spaces is no key, like an empty one. */
function validateKbd(component: Component): ValidationIssue[] {
  const blank = component.children.every(
    (child) => child.type === "text" && (child as { value?: string }).value?.trim() === "",
  );
  return blank && component.children.length > 0
    ? [{ id: "topik-kbd-children", message: "kbd requires a key name, not only whitespace" }]
    : [];
}

export const kbdDefinition: ComponentDefinition = {
  kind: "inline",
  render: "TopikKbd",
  description:
    "One key the reader presses, such as Ctrl or Enter; write a combination as several keys.",
  attributes: {},
  children: "inline",
  validate: validateKbd,
};

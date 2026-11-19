import type { ComponentDefinition } from "../registry.js";

export const kbdDefinition: ComponentDefinition = {
  kind: "inline",
  render: "TopikKbd",
  description: "A key or key combination the reader presses, such as Ctrl or Enter.",
  attributes: {},
  children: "inline",
};

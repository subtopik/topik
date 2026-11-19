import type { ComponentDefinition } from "../registry.js";

export const kbdDefinition: ComponentDefinition = {
  kind: "inline",
  render: "TopikKbd",
  description:
    "One key the reader presses, such as Ctrl or Enter; write a combination as several keys.",
  attributes: {},
  children: "inline",
};

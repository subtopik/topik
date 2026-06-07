import type { Schema } from "@markdoc/markdoc";
import { FLOW_CHILDREN } from "./helpers";

export const accordionTag: Schema = {
  render: "TopikAccordion",
  children: [...FLOW_CHILDREN],
  attributes: {
    title: { type: String, required: true },
    open: { type: Boolean },
  },
};

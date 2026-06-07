import type { Schema } from "@markdoc/markdoc";
import { CALLOUT_VARIANTS } from "../components";
import { FLOW_CHILDREN } from "./helpers";

export const calloutTag: Schema = {
  render: "TopikCallout",
  children: [...FLOW_CHILDREN],
  attributes: {
    variant: { type: String, matches: [...CALLOUT_VARIANTS], default: "note" },
    title: { type: String },
  },
};

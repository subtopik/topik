import type { Schema } from "@markdoc/markdoc";
import { FLOW_CHILDREN, validateNumericRange, validateOnlyDirectTagChildren } from "./helpers";

export const cardGridTag: Schema = {
  render: "TopikCardGrid",
  children: ["tag"],
  attributes: {
    columns: { type: Number, validate: validateNumericRange("columns", 1, 4) },
  },
  validate: validateOnlyDirectTagChildren("cardGrid", ["card"]),
};

export const cardTag: Schema = {
  render: "TopikCard",
  children: [...FLOW_CHILDREN],
  attributes: {
    title: { type: String, required: true },
    href: { type: String },
    icon: { type: String },
  },
};

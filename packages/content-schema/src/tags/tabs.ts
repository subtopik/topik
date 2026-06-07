import type { Schema } from "@markdoc/markdoc";
import {
  FLOW_CHILDREN,
  composeValidators,
  validateOnlyDirectTagChildren,
  validateParentTag,
  validateRequiredDirectTagChild,
} from "./helpers";

export const tabsTag: Schema = {
  render: "TopikTabs",
  children: ["tag"],
  validate: composeValidators(
    validateOnlyDirectTagChildren("tabs", ["tab"]),
    validateRequiredDirectTagChild("tabs", "tab"),
  ),
};

export const tabTag: Schema = {
  render: "TopikTab",
  children: [...FLOW_CHILDREN],
  attributes: {
    title: { type: String, required: true },
  },
  validate: validateParentTag("tabs"),
};

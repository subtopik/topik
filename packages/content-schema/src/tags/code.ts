import type { Schema } from "@markdoc/markdoc";
import {
  composeValidators,
  validateOnlyDirectTagChildren,
  validateParentTag,
  validateRequiredDirectChild,
  validateRequiredDirectTagChild,
} from "./helpers";

export const codeGroupTag: Schema = {
  render: "TopikCodeGroup",
  children: ["tag"],
  validate: composeValidators(
    validateOnlyDirectTagChildren("codeGroup", ["codeTab"]),
    validateRequiredDirectTagChild("codeGroup", "codeTab"),
  ),
};

export const codeTabTag: Schema = {
  render: "TopikCodeTab",
  children: ["fence"],
  attributes: {
    title: { type: String, required: true },
    icon: { type: String },
  },
  validate: composeValidators(
    validateParentTag("codeGroup"),
    validateRequiredDirectChild("codeTab", "fence"),
  ),
};

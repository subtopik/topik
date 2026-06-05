import type { Schema } from "@markdoc/markdoc";
import {
  FLOW_CHILDREN,
  composeValidators,
  validateOnlyDirectTagChildren,
  validateParentTag,
  validateRequiredDirectTagChild,
} from "./helpers";

export const stepsTag: Schema = {
  render: "TopikSteps",
  children: ["tag"],
  validate: composeValidators(
    validateOnlyDirectTagChildren("steps", ["step"]),
    validateRequiredDirectTagChild("steps", "step"),
  ),
};

export const stepTag: Schema = {
  render: "TopikStep",
  children: [...FLOW_CHILDREN],
  attributes: {
    title: { type: String },
  },
  validate: validateParentTag("steps"),
};

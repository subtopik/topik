import type { Schema } from "@markdoc/markdoc";
import { BADGE_VARIANTS } from "../components";
import { INLINE_CHILDREN } from "./helpers";

export const badgeTag: Schema = {
  render: "TopikBadge",
  inline: true,
  children: [...INLINE_CHILDREN],
  attributes: {
    variant: { type: String, matches: [...BADGE_VARIANTS], default: "neutral" },
  },
};

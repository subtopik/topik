import type { Schema } from "@markdoc/markdoc";

export const mathTag: Schema = {
  render: "TopikMath",
  selfClosing: true,
  attributes: {
    content: { type: String, required: true },
  },
};

export const mathInlineTag: Schema = {
  render: "TopikMathInline",
  inline: true,
  selfClosing: true,
  attributes: {
    content: { type: String, required: true },
  },
};

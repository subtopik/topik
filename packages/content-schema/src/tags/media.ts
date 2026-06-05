import type { Schema } from "@markdoc/markdoc";

export const figureTag: Schema = {
  render: "TopikFigure",
  selfClosing: true,
  attributes: {
    src: { type: String, required: true },
    alt: { type: String, required: true },
    caption: { type: String },
  },
};

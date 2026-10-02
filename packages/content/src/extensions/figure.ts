import type { ComponentDefinition } from "../registry.js";

export const figureDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikFigure",
  description: "Media with an optional caption.",
  attributes: {
    src: {
      type: "string",
      required: true,
      asset: true,
      assetReference: { slot: "figure.src", role: "image-light" },
      description: "Default/light image source URL.",
    },
    darkSrc: {
      type: "string",
      asset: true,
      assetReference: { slot: "figure.darkSrc", role: "image-dark" },
      description: "Optional dark-mode image source URL.",
    },
    alt: { type: "string", required: true, description: "Accessible alternative text." },
    caption: { type: "string", description: "Optional figure caption." },
  },
  children: "none",
};

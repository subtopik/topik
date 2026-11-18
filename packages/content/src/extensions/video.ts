import type { ComponentDefinition } from "../registry.js";

export const videoDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikVideo",
  description: "A video with a title, an optional caption and an optional poster image.",
  attributes: {
    src: {
      type: "string",
      required: true,
      asset: true,
      assetReference: { slot: "video.src", role: "video" },
      description: "Video source: a local MP4 or WebM file, or an external HTTPS URL.",
    },
    title: {
      type: "string",
      required: true,
      description: "Accessible name of the video, also used as the fallback link text.",
    },
    caption: { type: "string", description: "Optional video caption." },
    poster: {
      type: "string",
      asset: true,
      assetReference: { slot: "video.poster", role: "image" },
      description: "Optional image shown before playback and in printed or fallback output.",
    },
    loop: {
      type: "boolean",
      default: false,
      description:
        "Play as a muted, looping clip with a pause button instead of player controls; readers who prefer reduced motion start it paused.",
    },
  },
  children: "none",
};

import type { AuthoredAttributeValue } from "../model.js";
import type { ComponentDefinition, ValidationIssue } from "../registry.js";
import { parseTopikYouTubeUrl } from "../youtube.js";
import { blankText } from "./youtube.js";

/**
 * The title names the player for assistive technology, so it cannot be blank. A YouTube page is
 * not a video file a browser plays; it belongs in the youtube component.
 */
function validateVideo(
  _component: unknown,
  props: Record<string, AuthoredAttributeValue>,
): ValidationIssue[] {
  const { src, title } = props;
  const issues: ValidationIssue[] = [];
  if (typeof src === "string" && parseTopikYouTubeUrl(src))
    issues.push({
      id: "topik-video-youtube",
      message: "video plays video files; use youtube for a YouTube video",
      attribute: "src",
    });
  if (blankText(title))
    issues.push({
      id: "topik-video-title",
      message: "video requires a non-blank title",
      attribute: "title",
    });
  return issues;
}

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
  validate: validateVideo,
};

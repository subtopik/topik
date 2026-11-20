import type { AuthoredAttributeValue } from "../model.js";
import type { ComponentDefinition, ValidationIssue } from "../registry.js";
import { parseTopikYouTubeUrl } from "../youtube.js";

export function blankText(value: AuthoredAttributeValue | undefined): boolean {
  return typeof value === "string"
    ? value.trim() === ""
    : typeof value === "object" &&
        value.segments.every(
          (segment) => segment.type === "literal" && segment.value.trim() === "",
        );
}

/** The source names one YouTube video, and the title names the player, so it cannot be blank. */
function validateYouTube(
  _component: unknown,
  props: Record<string, AuthoredAttributeValue>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { src, title } = props;
  if (typeof src === "string" && !parseTopikYouTubeUrl(src))
    issues.push({
      id: "topik-youtube-src",
      message: "youtube requires a YouTube video URL, such as https://www.youtube.com/watch?v=…",
      attribute: "src",
    });
  if (blankText(title))
    issues.push({
      id: "topik-youtube-title",
      message: "youtube requires a non-blank title",
      attribute: "title",
    });
  return issues;
}

export const youtubeDefinition: ComponentDefinition = {
  kind: "block",
  render: "TopikYouTube",
  description:
    "A YouTube video, loaded only when the reader plays it, with a title and an optional caption.",
  attributes: {
    src: {
      type: "string",
      required: true,
      description:
        "The video's YouTube URL, such as https://www.youtube.com/watch?v=… or https://youtu.be/…; a t or start parameter sets the start time.",
    },
    title: {
      type: "string",
      required: true,
      description: "Accessible name of the player, also the text of the link to YouTube.",
    },
    caption: { type: "string", description: "Optional video caption." },
  },
  children: "none",
  validate: validateYouTube,
};

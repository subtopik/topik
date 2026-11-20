import { useState } from "react";
import {
  parseTopikYouTubeUrl,
  topikYouTubeEmbedUrl,
  topikYouTubeWatchUrl,
  type TopikYouTubeVideo,
} from "@topik/content";
import type { TopikComponentProps } from "../core/components";

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * A YouTube video. The page shows a link to the video; activating it replaces the link with the
 * embedded player, so the reader's browser makes no request to YouTube until the reader asks for
 * the video. Without script the link opens the video on YouTube, and a printed page shows it.
 */
export function TopikYouTube(props: TopikComponentProps) {
  const source = stringAttribute(props.src);
  const video = source === undefined ? undefined : parseTopikYouTubeUrl(source);
  if (!video) return null;
  // Activation belongs to one video: another video or start time waits for its own click, while a
  // changed title or caption keeps a playing video playing.
  return <YouTubeFigure key={topikYouTubeEmbedUrl(video)} {...props} video={video} />;
}

function YouTubeFigure({
  caption,
  title,
  video,
}: TopikComponentProps & { video: TopikYouTubeVideo }) {
  const [playing, setPlaying] = useState(false);
  const titleText = stringAttribute(title)?.trim() ?? "";
  const captionText = stringAttribute(caption);
  const watch = topikYouTubeWatchUrl(video);
  return (
    <figure className="topik-youtube">
      <div className="topik-youtube__frame">
        {playing ? (
          <iframe
            className="topik-youtube__player"
            src={topikYouTubeEmbedUrl(video)}
            title={titleText || "YouTube video"}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <a
            className="topik-youtube__start"
            href={watch}
            onClick={(event) => {
              // Modified clicks keep the browser's own handling, such as a new tab.
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
              if (event.altKey) return;
              event.preventDefault();
              setPlaying(true);
            }}
          >
            <span className="topik-youtube__play" aria-hidden="true" />
            <span className="topik-youtube__title">{titleText || watch}</span>
            <span className="topik-youtube__note">Plays from YouTube</span>
          </a>
        )}
      </div>
      <a className="topik-youtube__print" href={watch}>
        {titleText || watch}
      </a>
      {captionText ? <figcaption>{captionText}</figcaption> : null}
    </figure>
  );
}

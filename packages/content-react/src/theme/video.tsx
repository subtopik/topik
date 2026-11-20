import { useEffect, useRef, useState } from "react";
import type { TopikComponentProps } from "../core/components";

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Browsers may refuse playback, for example under data saving; the reader can still press Play. */
function startPlayback(video: HTMLVideoElement): void {
  try {
    void Promise.resolve(video.play()).catch(() => {});
  } catch {
    // Environments without media playback keep the clip paused.
  }
}

/**
 * The poster and title as a link to the source: the fallback, and what a printed page shows. A
 * source the browser may only request with CORS, such as a local preview stream, gets no link:
 * navigating to it cannot succeed.
 */
function VideoLink({
  poster,
  source,
  title,
}: {
  poster: string | undefined;
  source: string | undefined;
  title: string;
}) {
  // A link needs a name: without a title, the address names it.
  const label = title || source;
  const content = (
    <>
      {poster ? <img alt="" src={poster} /> : null}
      {label ? <span className="topik-video__title">{label}</span> : null}
    </>
  );
  return source ? (
    <a className="topik-video__link" href={source}>
      {content}
    </a>
  ) : (
    <div className="topik-video__fallback">{content}</div>
  );
}

function VideoPlayer({
  crossOrigin,
  loop,
  onFailure,
  poster,
  source,
  title,
}: {
  crossOrigin: "anonymous" | undefined;
  loop: boolean;
  onFailure: () => void;
  poster: string | undefined;
  source: string;
  title: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const failure = useRef(onFailure);
  failure.current = onFailure;
  // Server-rendered and unhydrated clips keep native controls, so they stay playable without script.
  const [hydrated, setHydrated] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    // An error before hydration dispatches no React event; read the element's state instead.
    if (element.error) {
      failure.current();
      return;
    }
    setHydrated(true);
    setPlaying(!element.paused);
    if (!loop) return;
    // Browsers autoplay only muted media. React does not server-render `muted`, so the property is
    // set here; before hydration the clip has controls and plays only when the reader starts it.
    element.muted = true;
    if (!prefersReducedMotion()) startPlayback(element);
  }, [loop]);

  const clip = loop && hydrated;
  return (
    <div className="topik-video__frame">
      <video
        ref={video}
        aria-label={title || undefined}
        className="topik-video__player"
        controls={!clip}
        crossOrigin={crossOrigin}
        loop={loop}
        playsInline
        poster={poster}
        preload="metadata"
        src={source}
        onError={() => failure.current()}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
      >
        {crossOrigin ? title : <a href={source}>{title || source}</a>}
      </video>
      {clip ? (
        <button
          type="button"
          className="topik-video__toggle"
          aria-label={title ? `${playing ? "Pause" : "Play"} ${title}` : undefined}
          onClick={() => {
            const element = video.current;
            if (!element) return;
            if (element.paused) startPlayback(element);
            else element.pause();
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
      ) : null}
    </div>
  );
}

/** Whether a URL names a video file a browser can play, judged by its path. */
function isVideoFileUrl(source: string): boolean {
  try {
    return /\.(?:mp4|m4v|webm)$/iu.test(new URL(source, "https://topik.invalid/").pathname);
  } catch {
    return false;
  }
}

/**
 * A native video player. A source the browser cannot play, such as a video page on a hosting
 * service, falls back to a link; applications that embed such services supply their own component.
 */
export function TopikVideo(props: TopikComponentProps) {
  // A changed source, including a return to one that failed before, gets a fresh attempt.
  return <VideoFigure key={stringAttribute(props.src) ?? ""} {...props} />;
}

function VideoFigure({
  __topikVideoFile,
  caption,
  crossOrigin,
  loop,
  poster,
  src,
  title,
}: TopikComponentProps) {
  const source = stringAttribute(src);
  const titleText = stringAttribute(title)?.trim() ?? "";
  const captionText = stringAttribute(caption);
  const posterSource = stringAttribute(poster);
  const corsOnly = crossOrigin === "anonymous";
  const [failed, setFailed] = useState(false);
  const link = (
    <VideoLink poster={posterSource} source={corsOnly ? undefined : source} title={titleText} />
  );
  const figcaption = captionText ? <figcaption>{captionText}</figcaption> : null;

  // A compiled source is a verified file. Any other source plays only when its path names a
  // video file; a page on a hosting service renders as a link, which works without script and
  // makes no request to the service until the reader follows it.
  const playable =
    source !== undefined && (__topikVideoFile === true || corsOnly || isVideoFileUrl(source));
  if (source === undefined || failed || !playable) {
    if (!titleText && !captionText && !posterSource && (corsOnly || source === undefined))
      return null;
    return (
      <figure className="topik-video">
        {link}
        {figcaption}
      </figure>
    );
  }
  return (
    <figure className="topik-video">
      <VideoPlayer
        // Switching between a clip and a player starts afresh, restoring sound and controls.
        key={loop === true ? "clip" : "player"}
        crossOrigin={corsOnly ? "anonymous" : undefined}
        loop={loop === true}
        onFailure={() => setFailed(true)}
        poster={posterSource}
        source={source}
        title={titleText}
      />
      <div className="topik-video__print">{link}</div>
      {figcaption}
    </figure>
  );
}

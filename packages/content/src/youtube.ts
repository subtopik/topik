import { hasControlCharacters } from "./text-controls.js";

/** A YouTube video named by a share URL: its ID and an optional start time in seconds. */
export interface TopikYouTubeVideo {
  id: string;
  start?: number;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const PATH_PREFIXES = ["/embed/", "/shorts/", "/live/"];

/** `90`, `90s` or `1h2m3s`, as YouTube writes start times. */
function parseStart(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/u.exec(value);
  if (!match || match[0] === "") return undefined;
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}

/**
 * The video a YouTube URL names, or `undefined` for anything else. Accepts the share forms
 * authors copy: `youtube.com/watch?v=…`, `youtu.be/…`, and `/embed/`, `/shorts/` and `/live/`
 * paths, including on `www.youtube-nocookie.com`. Only credential-free HTTPS URLs qualify. The start
 * time comes from the `t` or `start` parameter.
 */
export function parseTopikYouTubeUrl(source: string): TopikYouTubeVideo | undefined {
  if (source.trim() !== source || hasControlCharacters(source) || !/^https:\/\//i.test(source))
    return undefined;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  if (host === "youtu.be") id = url.pathname.slice(1);
  else if (WATCH_HOSTS.has(host) && url.pathname === "/watch") id = url.searchParams.get("v") ?? "";
  else if (WATCH_HOSTS.has(host) || host === "www.youtube-nocookie.com") {
    const prefix = PATH_PREFIXES.find((candidate) => url.pathname.startsWith(candidate));
    if (prefix) id = url.pathname.slice(prefix.length);
  }
  if (id === undefined) return undefined;
  if (id.endsWith("/")) id = id.slice(0, -1);
  if (!VIDEO_ID.test(id)) return undefined;
  const start = parseStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
  return start === undefined ? { id } : { id, start };
}

/** The page a reader opens without the embedded player, keeping the start time. */
export function topikYouTubeWatchUrl(video: TopikYouTubeVideo): string {
  return `https://www.youtube.com/watch?v=${video.id}${video.start ? `&t=${video.start}s` : ""}`;
}

/**
 * The privacy-enhanced player, which sets no cookies until the reader plays the video. It starts
 * playing at once, because it loads only after the reader asks for it.
 */
export function topikYouTubeEmbedUrl(video: TopikYouTubeVideo): string {
  return `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1${
    video.start ? `&start=${video.start}` : ""
  }`;
}

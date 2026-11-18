"use client";

import { createElement, useEffect, useLayoutEffect, useState, useRef, type ReactNode } from "react";
import type { TopikComponent, TopikComponentProps } from "./components";
import { getPreviewAssetToken } from "./preview-assets";

/**
 * Re-rendering a tree mints new tokens for the same targets. Media are equivalent when each
 * token names the same Asset, slot and adapter, and every other attribute is identical.
 */
function equivalentMedia(left: TopikComponentProps, right: TopikComponentProps): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    if (!Object.hasOwn(right, key)) return false;
    if (Object.is(left[key], right[key])) return true;
    const before = getPreviewAssetToken(left[key]);
    const after = getPreviewAssetToken(right[key]);
    return (
      before !== undefined &&
      after !== undefined &&
      before.name === after.name &&
      before.slot === after.slot &&
      before.state === after.state
    );
  });
}

/** @internal The only renderer boundary that accepts host-created media capabilities. */
export function PreviewMedia({
  component,
  attributes: renderedAttributes,
  children,
  source,
}: {
  component: TopikComponent;
  attributes: TopikComponentProps;
  children: ReactNode;
  /** Serialized resolved element, so re-resolving identical content keeps a pending download. */
  source: string;
}) {
  // Media state keys on the tokens' stable targets rather than on attribute object identity.
  const [attributes, setAttributes] = useState(renderedAttributes);
  const equivalent =
    attributes === renderedAttributes || equivalentMedia(attributes, renderedAttributes);
  if (!equivalent) setAttributes(renderedAttributes);
  const media = equivalent ? attributes : renderedAttributes;
  const [loaded, setLoaded] = useState<{
    attributes: TopikComponentProps;
    values: TopikComponentProps;
  }>();
  const [failed, setFailed] = useState<TopikComponentProps>();
  // An optional video poster that fails to load or decode is dropped; the video stays.
  const [brokenPoster, setBrokenPoster] = useState<TopikComponentProps>();
  const mounted = useRef(true);
  const currentAttributes = useRef(media);
  // Downloads act for the exact committed content, including changed link text. Every committed
  // change bumps the revision, so content that changes and then changes back still cancels.
  const committedSource = useRef({ source, revision: 0 });
  useLayoutEffect(() => {
    currentAttributes.current = media;
    const committed = committedSource.current;
    if (committed.source !== source)
      committedSource.current = { source, revision: committed.revision + 1 };
  }, [media, source]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const download = getPreviewAssetToken(media.href);
  // Suspense hides layout effects while keeping image-loading effects connected.
  // Let those effects retain their result; their own cleanup handles unmount.
  function isCurrent() {
    return (
      currentAttributes.current === media &&
      Object.values(media).every((value) => getPreviewAssetToken(value)?.state.active() !== false)
    );
  }
  useEffect(() => {
    let active = true;
    setFailed(undefined);
    if (!download) {
      void Promise.all(
        Object.entries(media).map(async ([key, value]) => {
          const token = getPreviewAssetToken(value);
          if (!token) return [key, value] as const;
          try {
            return [key, await token.state.load(token.name, token.slot)] as const;
          } catch (error) {
            if (token.slot === "video.poster") return [key, undefined] as const;
            throw error;
          }
        }),
      ).then(
        (entries) => {
          if (active && isCurrent())
            setLoaded({ attributes: media, values: Object.fromEntries(entries) });
        },
        () => {
          if (active && isCurrent()) setFailed(media);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [media, download]);
  if (failed === media)
    return <span role="alert">{download ? children : null} Preview media unavailable.</span>;
  if (download)
    return (
      <button
        type="button"
        onClick={() => {
          const clicked = media;
          const clickedRevision = committedSource.current.revision;
          const current = () =>
            mounted.current &&
            currentAttributes.current === clicked &&
            committedSource.current.revision === clickedRevision &&
            download.state.active();
          void download.state.load(download.name, download.slot).then(
            (url) => {
              if (!current()) return;
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = download.name;
              anchor.click();
            },
            () => {
              if (current()) setFailed(media);
            },
          );
        }}
      >
        {children}
      </button>
    );
  if (loaded?.attributes !== media) return <span role="status">Loading preview media…</span>;
  const slots = [media.src, media.darkSrc, media.poster].map(
    (value) => getPreviewAssetToken(value)?.slot,
  );
  const video = slots.some((slot) => slot?.startsWith("video."));
  const block = video || slots.some((slot) => slot?.startsWith("figure."));
  const streamed = slots.includes("video.src");
  const values = { ...loaded.values };
  // The producer serves streamed video only to CORS requests from the allowed origin.
  if (streamed) values.crossOrigin = "anonymous";
  if (brokenPoster === media) values.poster = undefined;
  return createElement(
    block ? "div" : "span",
    {
      style: { display: "contents" },
      onErrorCapture: (event: import("react").SyntheticEvent<HTMLElement>) => {
        if (!isCurrent()) return;
        if (event.target instanceof HTMLImageElement) {
          // In a video the only images are its optional poster.
          if (video) setBrokenPoster(media);
          else setFailed(media);
        } else if (event.target instanceof HTMLVideoElement && streamed) {
          // An external source that fails is the theme's to replace with a link.
          setFailed(media);
        }
      },
    },
    createElement(component, values, children),
  );
}

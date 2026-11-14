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
}: {
  component: TopikComponent;
  attributes: TopikComponentProps;
  children: ReactNode;
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
  const mounted = useRef(true);
  const currentAttributes = useRef(media);
  // Downloads act for the exact committed content, including changed link text.
  const currentRender = useRef(renderedAttributes);
  useLayoutEffect(() => {
    currentAttributes.current = media;
    currentRender.current = renderedAttributes;
  }, [media, renderedAttributes]);
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
          return [key, token ? await token.state.load(token.name, token.slot) : value] as const;
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
          const clicked = renderedAttributes;
          void download.state.load(download.name, download.slot).then(
            (url) => {
              if (!mounted.current || currentRender.current !== clicked || !download.state.active())
                return;
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = download.name;
              anchor.click();
            },
            () => {
              if (mounted.current && currentRender.current === clicked && download.state.active())
                setFailed(media);
            },
          );
        }}
      >
        {children}
      </button>
    );
  if (loaded?.attributes !== media) return <span role="status">Loading preview media…</span>;
  const figure = [media.src, media.darkSrc].some((value) =>
    getPreviewAssetToken(value)?.slot.startsWith("figure."),
  );
  return createElement(
    figure ? "div" : "span",
    {
      style: { display: "contents" },
      onErrorCapture: (event: import("react").SyntheticEvent<HTMLElement>) => {
        if (isCurrent() && event.target instanceof HTMLImageElement) setFailed(media);
      },
    },
    createElement(component, { ...loaded.values }, children),
  );
}

import { createElement, useEffect, useLayoutEffect, useState, useRef, type ReactNode } from "react";
import type { TopikComponent, TopikComponentProps } from "./components";
import { getPreviewAssetToken } from "./preview-assets";

/** @internal The only renderer boundary that accepts host-created media capabilities. */
export function PreviewMedia({
  component,
  attributes,
  children,
}: {
  component: TopikComponent;
  attributes: TopikComponentProps;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState<{
    attributes: TopikComponentProps;
    values: TopikComponentProps;
  }>();
  const [failed, setFailed] = useState<TopikComponentProps>();
  const mounted = useRef(true);
  const currentAttributes = useRef(attributes);
  useLayoutEffect(() => {
    currentAttributes.current = attributes;
  }, [attributes]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const download = getPreviewAssetToken(attributes.href);
  // Suspense hides layout effects while keeping image-loading effects connected.
  // Let those effects retain their result; their own cleanup handles unmount.
  function isCurrent() {
    return (
      currentAttributes.current === attributes &&
      Object.values(attributes).every(
        (value) => getPreviewAssetToken(value)?.state.active() !== false,
      )
    );
  }
  useEffect(() => {
    let active = true;
    setFailed(undefined);
    if (!download) {
      void Promise.all(
        Object.entries(attributes).map(async ([key, value]) => {
          const token = getPreviewAssetToken(value);
          return [key, token ? await token.state.load(token.name, token.slot) : value] as const;
        }),
      ).then(
        (entries) => {
          if (active && isCurrent()) setLoaded({ attributes, values: Object.fromEntries(entries) });
        },
        () => {
          if (active && isCurrent()) setFailed(attributes);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [attributes, download]);
  if (failed === attributes)
    return <span role="alert">{download ? children : null} Preview media unavailable.</span>;
  if (download)
    return (
      <button
        type="button"
        onClick={() => {
          void download.state.load(download.name, download.slot).then(
            (url) => {
              if (
                !mounted.current ||
                currentAttributes.current !== attributes ||
                !download.state.active()
              )
                return;
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = download.name;
              anchor.click();
            },
            () => {
              if (
                mounted.current &&
                currentAttributes.current === attributes &&
                download.state.active()
              )
                setFailed(attributes);
            },
          );
        }}
      >
        {children}
      </button>
    );
  if (loaded?.attributes !== attributes) return <span role="status">Loading preview media…</span>;
  const figure = [attributes.src, attributes.darkSrc].some((value) =>
    getPreviewAssetToken(value)?.slot.startsWith("figure."),
  );
  return createElement(
    figure ? "div" : "span",
    {
      style: { display: "contents" },
      onErrorCapture: (event: import("react").SyntheticEvent<HTMLElement>) => {
        if (isCurrent() && event.target instanceof HTMLImageElement) setFailed(attributes);
      },
    },
    createElement(component, { ...loaded.values }, children),
  );
}

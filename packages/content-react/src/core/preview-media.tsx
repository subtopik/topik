import { createElement, useEffect, useState, useRef, type ReactNode } from "react";
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
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const currentAttributes = useRef(attributes);
  currentAttributes.current = attributes;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const download = getPreviewAssetToken(attributes.href);
  useEffect(() => {
    let active = true;
    setFailed(false);
    if (!download) {
      void Promise.all(
        Object.entries(attributes).map(async ([key, value]) => {
          const token = getPreviewAssetToken(value);
          return [key, token ? await token.state.load(token.name, token.slot) : value] as const;
        }),
      ).then(
        (entries) => {
          if (active) setLoaded({ attributes, values: Object.fromEntries(entries) });
        },
        () => {
          if (active) setFailed(true);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [attributes, download]);
  if (failed)
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
                setFailed(true);
            },
          );
        }}
      >
        {children}
      </button>
    );
  if (loaded?.attributes !== attributes) return <span role="status">Loading preview media…</span>;
  return createElement(component, { ...loaded.values }, children);
}

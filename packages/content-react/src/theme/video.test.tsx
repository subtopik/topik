// @vitest-environment jsdom

import { createHash, webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { renderTopikMarkdown } from "../core/render";
import { createPreviewAssetAdapter, type PreviewAssetAdapter } from "../core/preview-assets";
import { TopikContent } from "./TopikContent";
import { TopikVideo } from "./video";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let adapter: PreviewAssetAdapter | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  adapter?.dispose();
  adapter = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(): { container: HTMLDivElement; root: Root } {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  return { container, root };
}

function stubPlayback(): { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> } {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
  return { play, pause };
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query === "(prefers-reduced-motion: reduce)",
      media: query,
    })),
  );
}

describe("TopikVideo", () => {
  test("renders a native player named by its title, with a print link and caption", () => {
    const html = renderToStaticMarkup(
      <TopikVideo
        src="/intro.mp4"
        title="Intro"
        caption="A tour"
        poster="/intro.png"
        loop={false}
      />,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const video = document.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/intro.mp4");
    expect(video?.getAttribute("aria-label")).toBe("Intro");
    expect(video?.getAttribute("poster")).toBe("/intro.png");
    expect(video?.getAttribute("preload")).toBe("metadata");
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.hasAttribute("loop")).toBe(false);
    expect(video?.hasAttribute("crossorigin")).toBe(false);
    expect(video?.querySelector("a")?.getAttribute("href")).toBe("/intro.mp4");
    const print = document.querySelector(".topik-video__print a");
    expect(print?.getAttribute("href")).toBe("/intro.mp4");
    expect(print?.querySelector("img")?.getAttribute("src")).toBe("/intro.png");
    expect(print?.textContent).toBe("Intro");
    expect(document.querySelector("figcaption")?.textContent).toBe("A tour");
  });

  test("server-renders a loop clip with controls, so it plays without script", () => {
    const html = renderToStaticMarkup(<TopikVideo src="/clip.webm" title="Clip" loop />);
    expect(html).toContain("controls");
    expect(html).not.toContain("autoplay");
    expect(html).not.toContain("topik-video__toggle");
  });

  test("a hydrated loop clip plays muted and offers a pause button", async () => {
    stubReducedMotion(false);
    const { play, pause } = stubPlayback();
    const { container, root } = mount();
    await act(async () => root.render(<TopikVideo src="/clip.webm" title="Clip" loop />));

    const video = container.querySelector("video")!;
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.hasAttribute("controls")).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
    const toggle = container.querySelector<HTMLButtonElement>(".topik-video__toggle")!;
    expect(toggle.textContent).toBe("Pause");
    expect(toggle.getAttribute("aria-label")).toBe("Pause Clip");

    await act(async () => toggle.click());
    expect(pause).toHaveBeenCalledTimes(1);
    expect(toggle.textContent).toBe("Play");
    expect(toggle.getAttribute("aria-label")).toBe("Play Clip");
  });

  test("a loop clip stays paused when the reader prefers reduced motion", async () => {
    stubReducedMotion(true);
    const { play } = stubPlayback();
    const { container, root } = mount();
    await act(async () => root.render(<TopikVideo src="/clip.webm" title="Clip" loop />));

    expect(play).not.toHaveBeenCalled();
    const toggle = container.querySelector<HTMLButtonElement>(".topik-video__toggle")!;
    expect(toggle.textContent).toBe("Play");
    await act(async () => toggle.click());
    expect(play).toHaveBeenCalledTimes(1);
    expect(toggle.textContent).toBe("Pause");
  });

  test("hydrates a server-rendered clip without a mismatch", async () => {
    stubReducedMotion(true);
    stubPlayback();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    const element = <TopikVideo src="/clip.webm" title="Clip" loop />;
    container.innerHTML = renderToString(element);
    await act(async () => {
      root = hydrateRoot(container!, element);
    });
    expect(errors).not.toHaveBeenCalled();
    expect(container.querySelector(".topik-video__toggle")).not.toBeNull();
  });

  test("a source the browser cannot play falls back to a link", async () => {
    const { container, root } = mount();
    await act(async () =>
      root.render(
        <TopikVideo
          src="https://www.youtube.com/watch?v=abc123&t=90s"
          title="Intro"
          caption="A tour"
        />,
      ),
    );
    await act(async () => container.querySelector("video")!.dispatchEvent(new Event("error")));

    expect(container.querySelector("video")).toBeNull();
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://www.youtube.com/watch?v=abc123&t=90s");
    expect(link.textContent).toBe("Intro");
    expect(container.querySelector("figcaption")?.textContent).toBe("A tour");
  });

  test("an error before hydration also falls back to a link", async () => {
    const { container, root } = mount();
    // jsdom has no media error state; give every element one until the test ends.
    Object.defineProperty(HTMLMediaElement.prototype, "error", {
      configurable: true,
      get: () => ({ code: 4 }),
    });
    try {
      await act(async () => root.render(<TopikVideo src="/broken.mp4" title="Intro" />));
    } finally {
      delete (HTMLMediaElement.prototype as { error?: unknown }).error;
    }
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/broken.mp4");
  });

  test("an unresolved source keeps the title and caption readable", () => {
    expect(renderToStaticMarkup(<TopikVideo title="Intro" caption="A tour" />)).toBe(
      '<figure class="topik-video"><div class="topik-video__fallback"><span class="topik-video__title">Intro</span></div><figcaption>A tour</figcaption></figure>',
    );
    expect(renderToStaticMarkup(<TopikVideo />)).toBe("");
  });

  test("passes only an anonymous cross-origin mode to the element", () => {
    const corsOnly = renderToStaticMarkup(
      <TopikVideo src="/a.mp4" title="A" crossOrigin="anonymous" />,
    );
    expect(corsOnly).toContain('crossorigin="anonymous"');
    // Navigation cannot make a CORS request, so a CORS-only source is never linked.
    expect(corsOnly).not.toContain("<a ");
    expect(
      renderToStaticMarkup(<TopikVideo src="/a.mp4" title="A" crossOrigin="use-credentials" />),
    ).not.toContain("crossorigin");
  });
});

describe("video content", () => {
  test("the themed renderer plays a compiled video", () => {
    const html = renderToStaticMarkup(
      <TopikContent content={'{% video src="https://cdn.example.com/a.mp4" title="Intro" /%}'} />,
    );
    expect(html).toContain('<video aria-label="Intro"');
    expect(html).toContain('src="https://cdn.example.com/a.mp4"');
  });

  test("without a themed component, a video is a link with its poster and caption", () => {
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          '{% video src="https://cdn.example.com/a.mp4" title="Intro" caption="A tour" poster="https://cdn.example.com/a.png" /%}',
        )}
      </>,
    );
    // React may hoist an image preload hint ahead of the figure.
    expect(html).toContain(
      '<figure><a href="https://cdn.example.com/a.mp4"><img alt="" src="https://cdn.example.com/a.png"/>Intro</a><figcaption>A tour</figcaption></figure>',
    );
  });

  test("resolves generated source and poster names through resolveAsset", () => {
    const video = `auto-v1-${"a".repeat(52)}`;
    const poster = `auto-v1-${"b".repeat(51)}a`;
    const html = renderToStaticMarkup(
      <TopikContent
        content={`{% video src="asset:${video}" title="Intro" poster="asset:${poster}" /%}`}
        resolveAsset={(name) => `https://cdn.example.com/${name}`}
      />,
    );
    expect(html).toContain(`src="https://cdn.example.com/${video}"`);
    expect(html).toContain(`poster="https://cdn.example.com/${poster}"`);
  });

  test("reports an unresolved video asset and keeps the title", async () => {
    const video = `auto-v1-${"a".repeat(52)}`;
    const onAssetDiagnostic = vi.fn();
    const { container, root } = mount();
    await act(async () =>
      root.render(
        <TopikContent
          content={`{% video src="asset:${video}" title="Intro" /%}`}
          resolveAsset={() => undefined}
          onAssetDiagnostic={onAssetDiagnostic}
        />,
      ),
    );
    expect(onAssetDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MISSING", slot: "video.src" }),
    );
    expect(container.textContent).toContain("Intro");
    expect(container.querySelector("video")).toBeNull();
  });
});

describe("video preview", () => {
  const video = `auto-v1-${"a".repeat(52)}`;
  const poster = `auto-v1-${"b".repeat(51)}a`;
  const videoBytes = new Uint8Array([4, 5, 6]);
  const posterBytes = new Uint8Array([1, 2, 3]);
  const videoDigest = createHash("sha256").update(videoBytes).digest("hex");
  const posterDigest = createHash("sha256").update(posterBytes).digest("hex");

  function createAdapter(videoType = "video/mp4"): PreviewAssetAdapter {
    const assets = [
      [video, videoDigest, videoType, videoBytes],
      [poster, posterDigest, "image/png", posterBytes],
    ] as const;
    return createPreviewAssetAdapter({
      origin: "http://localhost:50001",
      snapshot: {
        sessionId: "one",
        generation: 3,
        resources: assets.map(([name, digest, mediaType, bytes]) => ({
          type: "Asset",
          name,
          spec: {
            uri: `blobs/${digest}`,
            integrity: `sha256:${digest}`,
            size: bytes.byteLength,
            mediaType,
          },
        })),
        payloads: assets.map(([name, digest, mediaType, bytes]) => ({
          path: `blobs/${digest}`,
          integrity: `sha256:${digest}`,
          size: bytes.byteLength,
          mediaType,
          assetNames: [name],
        })),
      },
    });
  }

  test("streams video from the producer and verifies only the poster", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL() {
          return "blob:poster";
        }
        static revokeObjectURL() {}
      },
    );
    const fetch = vi.fn(
      async (url: URL | string) =>
        Object.defineProperty(
          new Response(posterBytes, { headers: { "content-type": "image/png" } }),
          "url",
          { value: String(url) },
        ) as Response,
    );
    vi.stubGlobal("fetch", fetch);
    adapter = createAdapter();
    const { container, root } = mount();
    await act(async () =>
      root.render(
        <TopikContent
          content={`{% video src="asset:${video}" title="Intro" poster="asset:${poster}" /%}`}
          previewAssets={adapter}
        />,
      ),
    );
    // The poster loads and verifies asynchronously before the player renders.
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector("video")).not.toBeNull();
    });

    const element = container.querySelector("video")!;
    expect(element.getAttribute("src")).toBe(
      `http://localhost:50001/blobs/${videoDigest}?sessionId=one&generation=3`,
    );
    expect(element.getAttribute("crossorigin")).toBe("anonymous");
    expect(element.getAttribute("poster")).toBe("blob:poster");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain(posterDigest);
  });

  test("a preview video that fails to load shows the preview alert", async () => {
    adapter = createAdapter();
    const { container, root } = mount();
    await act(async () =>
      root.render(
        <TopikContent
          content={`Text survives.\n\n{% video src="asset:${video}" title="Intro" /%}`}
          previewAssets={adapter}
        />,
      ),
    );
    await act(async () => container.querySelector("video")!.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("Text survives.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Preview media unavailable.",
    );
  });

  test("a payload that is not MP4 or WebM receives no preview capability", async () => {
    adapter = createAdapter("video/quicktime");
    const onAssetDiagnostic = vi.fn();
    const { container, root } = mount();
    await act(async () =>
      root.render(
        <TopikContent
          content={`{% video src="asset:${video}" title="Intro" /%}`}
          previewAssets={adapter}
          onAssetDiagnostic={onAssetDiagnostic}
        />,
      ),
    );
    expect(container.innerHTML).not.toContain("localhost:50001");
    expect(onAssetDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MISSING", slot: "video.src" }),
    );
  });
});

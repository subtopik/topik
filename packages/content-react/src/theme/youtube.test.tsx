// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { getTopikComponents } from "../core/components";
import { renderTopikMarkdown } from "../core/render";
import { TopikContent } from "./TopikContent";
import { TopikYouTube } from "./youtube";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

function mount(): { container: HTMLDivElement; root: Root } {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  return { container, root };
}

const SOURCE = "https://youtu.be/dQw4w9WgXcQ?t=1m30s";

describe("TopikYouTube", () => {
  test("shows a link to the video and requests nothing from YouTube before it is played", () => {
    const html = renderToStaticMarkup(
      <TopikYouTube src={SOURCE} title="Installing the CLI" caption="Two minutes" />,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    const start = document.querySelector("a.topik-youtube__start")!;
    expect(start.getAttribute("href")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s");
    expect(start.textContent).toContain("Installing the CLI");
    expect(document.querySelector(".topik-youtube__print")?.getAttribute("href")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s",
    );
    expect(document.querySelector("figcaption")?.textContent).toBe("Two minutes");
  });

  test("playing replaces the link with the privacy-enhanced player at the start time", async () => {
    const { container, root } = mount();
    await act(async () => root.render(<TopikYouTube src={SOURCE} title="Installing the CLI" />));
    await act(async () =>
      container
        .querySelector<HTMLAnchorElement>("a.topik-youtube__start")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })),
    );
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=90",
    );
    expect(iframe.getAttribute("title")).toBe("Installing the CLI");
    expect(container.querySelector("a.topik-youtube__start")).toBeNull();
  });

  test("a modified click keeps the browser's handling, such as opening a new tab", async () => {
    const { container, root } = mount();
    await act(async () => root.render(<TopikYouTube src={SOURCE} title="Intro" />));
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    await act(async () => container.querySelector("a.topik-youtube__start")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("another video waits for its own click; a new title keeps playback", async () => {
    const { container, root } = mount();
    const play = async () =>
      act(async () =>
        container
          .querySelector("a.topik-youtube__start")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })),
      );
    await act(async () => root.render(<TopikYouTube src={SOURCE} title="Intro" />));
    await play();
    await act(async () => root.render(<TopikYouTube src={SOURCE} title="Renamed" />));
    expect(container.querySelector("iframe")?.getAttribute("title")).toBe("Renamed");
    await act(async () =>
      root.render(<TopikYouTube src="https://youtu.be/aaaaaaaaaaa" title="Next" />),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a.topik-youtube__start")?.getAttribute("href")).toBe(
      "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    );
    // A different start time is a different video too.
    await play();
    await act(async () =>
      root.render(<TopikYouTube src="https://youtu.be/aaaaaaaaaaa?t=30" title="Next" />),
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("a source that is not a YouTube video renders nothing", () => {
    expect(renderToStaticMarkup(<TopikYouTube src="https://example.com/v" title="x" />)).toBe("");
  });

  test("the plain renderer links to the video", () => {
    const { TopikYouTube: Plain } = getTopikComponents();
    const html = renderToStaticMarkup(<Plain src={SOURCE} title="Intro" caption="A tour" />);
    expect(html).toBe(
      '<figure><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s">Intro</a><figcaption>A tour</figcaption></figure>',
    );
  });

  test("authored content renders through the themed and plain renderers", () => {
    const source = `{% youtube src="${SOURCE}" title="Intro" /%}`;
    const themed = renderToStaticMarkup(<TopikContent content={source} />);
    expect(themed).toContain('class="topik-youtube"');
    expect(themed).not.toContain("<iframe");
    const plain = renderToStaticMarkup(<>{renderTopikMarkdown(source)}</>);
    expect(plain).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s"');
  });
});

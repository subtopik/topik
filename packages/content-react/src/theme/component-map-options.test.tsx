// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TopikContentProvider } from "../core/context";
import type { TopikLinkRenderProps } from "../core/components";
import { getRichTopikComponents, RichTopikContentProvider } from "../rich";
import { TopikContent } from "./TopikContent";

const content = [
  '{% figure src="https://example.com/light.png" darkSrc="https://example.com/dark.png" alt="Theme" /%}',
  "[Link](/link)",
  '{% card title="Card" href="/card" %}\nBody\n{% /card %}',
].join("\n\n");

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

const renderLink = (props: TopikLinkRenderProps) => <a {...props} data-custom="explicit" />;

describe("full rich component map options", () => {
  it.each(["plain", "full-map", "rich-provider"])(
    "preserves explicit figure and link options through %s",
    (mode) => {
      const article = (
        <TopikContent
          content={content}
          colorScheme="dark"
          renderLink={renderLink}
          resolveLink={(href) => `/resolved${href}`}
          components={mode === "full-map" ? getRichTopikComponents() : undefined}
        />
      );
      const html = renderToStaticMarkup(
        mode === "rich-provider" ? (
          <RichTopikContentProvider>{article}</RichTopikContentProvider>
        ) : (
          article
        ),
      );
      expect(html).toContain('src="https://example.com/dark.png"');
      expect(html).not.toContain("<source");
      expect(html).toContain('href="/resolved/link"');
      expect(html).toContain('href="/resolved/card"');
      expect(html.match(/data-custom="explicit"/g)).toHaveLength(2);
    },
  );

  it.each([false, true])(
    "retains provider defaults and explicit precedence (explicit: %s)",
    (explicit) => {
      const contextNavigate = vi.fn((_href: string) => true);
      const explicitNavigate = vi.fn((_href: string) => true);
      const contextResolve = vi.fn((href: string) => `/context${href}`);
      const explicitResolve = vi.fn((href: string) => `/explicit${href}`);
      const dom = mount(
        <TopikContentProvider
          colorScheme="light"
          onNavigateLink={contextNavigate}
          resolveLink={contextResolve}
          renderLink={(props) => <a {...props} data-custom="context" />}
        >
          <TopikContent
            content={content}
            components={getRichTopikComponents()}
            {...(explicit
              ? {
                  colorScheme: "dark" as const,
                  onNavigateLink: explicitNavigate,
                  resolveLink: explicitResolve,
                  renderLink,
                }
              : {})}
          />
        </TopikContentProvider>,
      );
      const source = explicit ? "explicit" : "context";
      expect(dom.querySelector("img")?.getAttribute("src")).toBe(
        `https://example.com/${explicit ? "dark" : "light"}.png`,
      );
      const anchors = [...dom.querySelectorAll("a")];
      expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([
        `/${source}/link`,
        `/${source}/card`,
      ]);
      for (const anchor of anchors) {
        expect(anchor.dataset.custom).toBe(source);
        const event = new MouseEvent("click", { bubbles: true, cancelable: true });
        act(() => {
          anchor.dispatchEvent(event);
        });
        expect(event.defaultPrevented).toBe(true);
      }
      const handler = explicit ? explicitNavigate : contextNavigate;
      expect(handler.mock.calls.map(([href]) => href)).toEqual(["/link", "/card"]);
      expect(explicit ? contextNavigate : explicitNavigate).not.toHaveBeenCalled();
      expect(explicit ? contextResolve : explicitResolve).not.toHaveBeenCalled();
    },
  );
});

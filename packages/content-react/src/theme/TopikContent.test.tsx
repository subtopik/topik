import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { TopikContentProvider } from "../core/context";
import type { TopikLinkRenderProps } from "../core/components";
import { TopikContent } from "./TopikContent";

describe("TopikContent", () => {
  it("renders styled default components and resolves assets", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        content='{% callout title="Asset" %}{% figure src="asset:hero" alt="Hero" /%}{% /callout %}'
        resolveAsset={(id) => `/cdn/${id}.webp`}
      />,
    );

    expect(html).toContain('class="topik-content"');
    expect(html).toContain('class="topik-callout not-prose"');
    expect(html).toContain('src="/cdn/hero.webp"');
  });

  it("passes an explicit color scheme to figures", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        colorScheme="dark"
        content='{% figure src="asset:hero" darkSrc="asset:hero-dark" alt="Hero" /%}'
        resolveAsset={(id) => `/cdn/${id}.webp`}
      />,
    );

    expect(html).toContain('src="/cdn/hero-dark.webp"');
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("inherits an explicit color scheme from the provider", () => {
    const html = renderToStaticMarkup(
      <TopikContentProvider colorScheme="dark">
        <TopikContent content='{% figure src="/light.png" darkSrc="/dark.png" alt="Hero" /%}' />
      </TopikContentProvider>,
    );

    expect(html).toContain('src="/dark.png"');
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("supports component overrides", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        components={{
          TopikCallout: ({ children }) => <section className="custom-callout">{children}</section>,
        }}
        content='{% callout title="Custom" %}Body{% /callout %}'
      />,
    );

    expect(html).toContain("custom-callout");
    expect(html).toContain("Body");
  });

  it("passes the navigation handler to linked cards", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        components={{
          TopikCard: ({ onNavigateLink }) => (
            <span data-has-handler={typeof onNavigateLink === "function"} />
          ),
        }}
        content='{% card title="Start" href="/start" /%}'
        onNavigateLink={() => true}
      />,
    );

    expect(html).toContain('data-has-handler="true"');
  });

  it("resolves rendered link and card hrefs", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        content={'[Guide](/guide)\n\n{% card title="Card" href="/card" /%}'}
        resolveLink={(href) => `/preview${href}`}
      />,
    );

    expect(html).toContain('href="/preview/guide"');
    expect(html).toContain('href="/preview/card"');
  });

  it("renders links and cards through a framework adapter", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        content={'[Guide](/guide)\n\n{% card title="Card" href="/card" /%}'}
        renderLink={({ children, ...props }: TopikLinkRenderProps) => (
          <a {...props} data-framework-link>
            {children}
          </a>
        )}
      />,
    );

    expect(html.match(/data-framework-link/g)).toHaveLength(2);
    expect(html).toContain('href="/guide"');
    expect(html).toContain('href="/card"');
  });

  it("renders unsafe cards as non-interactive when validation is disabled", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        content='{% card title="Unsafe" href="javascript:alert(1)" /%}'
        validate={false}
      />,
    );

    expect(html).toContain('<div class="topik-card">');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=");
  });

  it("uses provider component overrides and asset resolver", () => {
    const html = renderToStaticMarkup(
      <TopikContentProvider
        components={{
          TopikFigure: ({ src }) => <span data-provider-src={String(src)} />,
        }}
        resolveAsset={(id) => `/provider/${id}.png`}
      >
        <TopikContent content='{% figure src="asset:hero" alt="Hero" /%}' />
      </TopikContentProvider>,
    );

    expect(html).toContain('data-provider-src="/provider/hero.png"');
  });

  it("keeps default quiz behavior when leaf components are overridden", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        components={{
          TopikChoice: ({ children }) => <span className="custom-choice">{children}</span>,
          TopikExplanation: ({ children }) => <div className="custom-explanation">{children}</div>,
        }}
        content="{% quiz %}{% question %}{% choice correct=true %}Yes{% /choice %}{% choice %}No{% /choice %}{% explanation %}Because yes.{% /explanation %}{% /question %}{% /quiz %}"
      />,
    );

    expect(html).toContain("custom-choice");
    expect(html).toContain("Yes");
    expect(html).toContain("No");
    expect(html).toContain('type="radio"');
  });
});

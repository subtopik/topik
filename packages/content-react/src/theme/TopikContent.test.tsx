import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { TopikContentProvider } from "../core/context";
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
    expect(html).toContain('class="topik-callout"');
    expect(html).toContain('src="/cdn/hero.webp"');
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

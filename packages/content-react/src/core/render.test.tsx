import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { TopikContentProvider, useTopikAssetResolver, useTopikComponents } from "./context";
import { getTopikComponents } from "./components";
import { compileTopikContent, renderTopikMarkdown } from "./render";

const allComponentsContent = `
# Lesson

{% callout variant="tip" title="Remember" %}
Use the helper.
{% /callout %}

{% cardGrid columns=2 %}
{% card title="One" href="/one" icon="1" %}
First card.
{% /card %}
{% /cardGrid %}

{% accordion title="Details" open=true %}
Hidden text.
{% /accordion %}

{% tabs %}
{% tab title="A" %}
Panel A.
{% /tab %}
{% tab title="B" %}
Panel B.
{% /tab %}
{% /tabs %}

{% steps %}
{% step title="Install" %}
Run it.
{% /step %}
{% /steps %}

{% figure src="asset:hero" darkSrc="asset:hero-dark" alt="Hero" caption="A figure" /%}

Inline {% badge variant="success" %}stable{% /badge %}.

{% quiz %}
{% question type="single-choice" %}
{% choice correct=true %}
Yes.
{% /choice %}
{% choice %}
No.
{% /choice %}
{% explanation %}
Because it is correct.
{% /explanation %}
{% /question %}
{% /quiz %}
`;

describe("content-react core", () => {
  it("renders basic markdown nodes", () => {
    const html = renderToStaticMarkup(<>{renderTopikMarkdown("# Hello\n\nParagraph.")}</>);

    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>Paragraph.</p>");
  });

  it("renders every Topik schema component with overrides", () => {
    const components = getTopikComponents({
      TopikAccordion: ({ children, title }) => (
        <section data-accordion={String(title)}>{children}</section>
      ),
      TopikBadge: ({ children }) => <mark>{children}</mark>,
      TopikCallout: ({ children, title }) => <aside data-callout={String(title)}>{children}</aside>,
      TopikCard: ({ children, title }) => <article data-card={String(title)}>{children}</article>,
      TopikCardGrid: ({ children }) => <div data-card-grid>{children}</div>,
      TopikChoice: ({ children }) => <div data-choice>{children}</div>,
      TopikExplanation: ({ children }) => <div data-explanation>{children}</div>,
      TopikFigure: ({ src }) => <img alt="" src={String(src)} />,
      TopikQuestion: ({ children }) => <div data-question>{children}</div>,
      TopikQuiz: ({ children }) => <div data-quiz>{children}</div>,
      TopikStep: ({ children, title }) => <li data-step={String(title)}>{children}</li>,
      TopikSteps: ({ children }) => <ol data-steps>{children}</ol>,
      TopikTab: ({ children, title }) => <section data-tab={String(title)}>{children}</section>,
      TopikTabs: ({ children }) => <div data-tabs>{children}</div>,
    });
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(allComponentsContent, {
          components,
          resolveAsset: (id) => `/assets/${id}.png`,
        })}
      </>,
    );

    expect(html).toContain('data-callout="Remember"');
    expect(html).toContain("data-card-grid");
    expect(html).toContain('data-card="One"');
    expect(html).toContain('data-accordion="Details"');
    expect(html).toContain("data-tabs");
    expect(html).toContain('data-tab="A"');
    expect(html).toContain("data-steps");
    expect(html).toContain('data-step="Install"');
    expect(html).toContain('src="/assets/hero.png"');
    expect(html).toContain("<mark>stable</mark>");
    expect(html).toContain("data-quiz");
    expect(html).toContain("data-question");
    expect(html).toContain("data-choice");
    expect(html).toContain("data-explanation");
  });

  it("provides components and asset resolver through context", () => {
    function ContextRenderer() {
      const components = useTopikComponents();
      const resolveAsset = useTopikAssetResolver();

      return (
        <>
          {renderTopikMarkdown('{% figure src="asset:logo" alt="Logo" /%}', {
            components,
            resolveAsset,
          })}
        </>
      );
    }

    const html = renderToStaticMarkup(
      <TopikContentProvider
        components={{
          TopikFigure: ({ src }) => <span data-src={String(src)} />,
        }}
        resolveAsset={(id) => `/resolved/${id}.svg`}
      >
        <ContextRenderer />
      </TopikContentProvider>,
    );

    expect(html).toContain('data-src="/resolved/logo.svg"');
  });

  it("reports validation diagnostics", () => {
    const diagnostics: string[] = [];

    const rendered = renderTopikMarkdown("{% quiz %}{% /quiz %}", {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });

    expect(rendered).toBeDefined();
    expect(diagnostics.some((message) => message.includes("'quiz' requires"))).toBe(true);
  });

  it("server-renders compiled content without crashing", () => {
    const tree = compileTopikContent('{% callout title="SSR" %}Works.{% /callout %}');
    const html = renderToString(
      <>{renderTopikMarkdown('{% callout title="SSR" %}Works.{% /callout %}')}</>,
    );

    expect(tree).toBeTruthy();
    expect(html).toContain("Works.");
  });
});

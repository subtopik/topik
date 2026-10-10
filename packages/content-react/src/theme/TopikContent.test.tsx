import { describe, expect, it, vi } from "vite-plus/test";
import { mergeTopikContentConfig } from "@topik/content";
import { renderToStaticMarkup } from "react-dom/server";
import { TopikContentProvider } from "../core/context";
import type { TopikLinkRenderProps } from "../core/components";
import { InvalidTopikContentError } from "../core/render";
import { TopikContent } from "./TopikContent";

describe("TopikContent", () => {
  it("keeps canonical validation after a caller mutates a merged schema", () => {
    const config = mergeTopikContentConfig();
    Reflect.set(config.components.quiz, "children", "blocks");
    const renderQuiz = vi.fn(() => <span>must not render</span>);
    const content = "{% quiz %}\nordinary child\n{% /quiz %}";
    expect(() =>
      renderToStaticMarkup(
        <TopikContent content={content} config={config} components={{ TopikQuiz: renderQuiz }} />,
      ),
    ).toThrow(InvalidTopikContentError);
    expect(renderQuiz).not.toHaveBeenCalled();
  });

  it("selects course content from declarative student variables", () => {
    const content =
      '{% if equals($student.role, "teacher") %}\nTeacher notes\n{% else /%}\nWelcome {% $student.name %}\n{% /if %}';
    const html = renderToStaticMarkup(
      <TopikContent
        content={content}
        config={{ variables: { student: { role: "student", name: "Ada" } } }}
      />,
    );
    expect(html).toContain("Welcome Ada");
    expect(html).not.toContain("Teacher notes");
  });

  it("throws for unsupported content by default", () => {
    expect(() =>
      renderToStaticMarkup(
        <TopikContent content='{% mystery private="opaque" %}leaked child{% /mystery %}' />,
      ),
    ).toThrow(InvalidTopikContentError);
  });

  it("renders the accessible invalid-content placeholder without unsupported children", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        content='{% mystery private="opaque" %}leaked child{% /mystery %}'
        invalidContent="placeholder"
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Unsupported or invalid Topik content");
    expect(html).not.toContain("leaked child");
    expect(html).not.toContain("opaque");
  });

  it("renders styled default components with portable asset paths", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        content={
          '{% callout title="Asset" %}\n{% figure src="assets/hero.webp" alt="Hero" /%}\n{% /callout %}'
        }
      />,
    );

    expect(html).toContain('class="topik-content"');
    expect(html).toContain('class="topik-callout not-prose"');
    expect(html).toContain('src="assets/hero.webp"');
  });

  it("server-renders a Markdown table with semantic rows and cells", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        content={["| Name | Value |", "| --- | --- |", "| Café | Ready |"].join("\n")}
      />,
    );

    expect(html).toContain('<div class="topik-table"><table>');
    expect(html).toContain("<thead><tr><th>Name</th><th>Value</th></tr></thead>");
    expect(html).toContain("<tbody><tr><td>Café</td><td>Ready</td></tr></tbody>");
  });

  it("preserves mixed-case credential-free HTTPS in the default renderer", () => {
    const references = [
      "HtTpS://example.com/image.png",
      "hTTps://example.com/manual.pdf",
      "HTTPS://example.com/autolink.pdf",
      "HTtPs://example.com/light.png",
      "htTPs://example.com/dark.png",
    ];
    const html = renderToStaticMarkup(
      <TopikContent
        content={[
          `![Image](${references[0]})`,
          `[Download](${references[1]})`,
          `<${references[2]}>`,
          `{% figure src="${references[3]}" darkSrc="${references[4]}" alt="Theme" /%}`,
        ].join("\n\n")}
      />,
    );

    for (const reference of references) expect(html).toContain(reference);
  });

  it("rejects mixed-case unsafe external media in the default renderer", () => {
    expect(() =>
      renderToStaticMarkup(
        <TopikContent
          content={[
            "![HTTP](HtTp://example.com/image.png)",
            "[HTTP](hTtP://example.com/manual.pdf)",
            "<HTtp://example.com/autolink.pdf>",
            '{% figure src="hTtPs://user:secret@example.com/image.png" alt="Unsafe" /%}',
            "![Protocol relative](//example.com/image.png)",
            '{% figure src="HtTpS://[invalid" alt="Malformed" /%}',
          ].join("\n\n")}
        />,
      ),
    ).toThrow(InvalidTopikContentError);
  });

  it("passes an explicit color scheme to figures", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        colorScheme="dark"
        content='{% figure src="assets/hero.webp" darkSrc="assets/hero-dark.webp" alt="Hero" /%}'
      />,
    );

    expect(html).toContain('src="assets/hero-dark.webp"');
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("inherits an explicit color scheme from the provider", () => {
    const html = renderToStaticMarkup(
      <TopikContentProvider colorScheme="dark">
        <TopikContent content='{% figure src="light.png" darkSrc="dark.png" alt="Hero" /%}' />
      </TopikContentProvider>,
    );

    expect(html).toContain('src="dark.png"');
    expect(html).not.toContain("prefers-color-scheme");
  });

  it.each([
    "http://example.com/a.png",
    "file:///tmp/a.png",
    "data:image/png;base64,AA==",
    "blob:https://example.com/id",
    "javascript:alert(1)",
    "//example.com/a.png",
    "/absolute.png",
    "assets%2fhero.png",
    "é.png",
  ])("fails closed for unsafe default-renderer asset reference %s", (reference) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <TopikContent
        content={`{% figure src="${reference}" alt="Unsafe" /%}`}
        invalidContent="placeholder"
        onDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
      />,
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(html).not.toContain(reference);
    expect(html).not.toMatch(/\b(?:src|srcset)="/iu);
    expect(html).not.toContain('rel="preload"');
  });

  it("supports component overrides", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        components={{
          TopikCallout: ({ children }) => <section className="custom-callout">{children}</section>,
        }}
        content={'{% callout title="Custom" %}\nBody\n{% /callout %}'}
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

  it("resolves resource links and cards once before SSR and framework adapters", () => {
    const resolveLink = vi.fn((href: string) =>
      href === "ref://guide/getting-started?view=full#setup"
        ? "/learn/start?view=full#setup"
        : undefined,
    );
    const html = renderToStaticMarkup(
      <TopikContent
        content={
          '[Install](ref://guide/getting-started?view=full#setup)\n\n{% card title="Start" href="ref://guide/getting-started?view=full#setup" /%}'
        }
        resolveLink={resolveLink}
        renderLink={(props) => <a {...props} data-framework-link />}
      />,
    );

    expect(html.match(/href="\/learn\/start\?view=full#setup"/gu)).toHaveLength(2);
    expect(html.match(/data-framework-link/gu)).toHaveLength(2);
    expect(html).not.toContain("ref://");
    expect(resolveLink).toHaveBeenCalledTimes(2);
    expect(resolveLink).toHaveBeenNthCalledWith(1, "ref://guide/getting-started?view=full#setup");
    expect(resolveLink).toHaveBeenNthCalledWith(2, "ref://guide/getting-started?view=full#setup");
  });

  it("resolves refs for custom components using provider routes", () => {
    const html = renderToStaticMarkup(
      <TopikContentProvider resolveLink={() => "/docs/current"}>
        <TopikContent
          content={
            '[Wiki](ref://wiki-page/wiki-name)\n\n{% card title="Wiki" href="ref://wiki-page/wiki-name" /%}'
          }
          components={{
            TopikLink: ({ children, href }) => <a href={String(href)}>{children}</a>,
            TopikCard: ({ href }) => <a href={String(href)}>Card</a>,
          }}
        />
      </TopikContentProvider>,
    );

    expect(html.match(/href="\/docs\/current"/gu)).toHaveLength(2);
    expect(html).not.toContain("ref://");
  });

  it.each([
    undefined,
    () => undefined,
    () => "ref://guide/still-unresolved",
    () => "javascript:alert(1)",
    () => {
      throw new Error("private route failure");
    },
  ])(
    "removes unresolved refs before custom rendering and reports safe diagnostics",
    (resolveLink) => {
      const diagnostics: string[] = [];
      const received: unknown[] = [];
      const html = renderToStaticMarkup(
        <TopikContent
          content={
            '[Wiki](ref://wiki-page/wiki-name)\n\n{% card title="Wiki" href="ref://wiki-page/wiki-name" /%}'
          }
          resolveLink={resolveLink}
          onLinkDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
          components={{
            TopikLink: ({ children, href }) => {
              received.push(href);
              return <>{children}</>;
            },
            TopikCard: ({ href }) => {
              received.push(href);
              return <span>Card</span>;
            },
          }}
        />,
      );

      expect(received).toEqual([undefined, undefined]);
      expect(diagnostics).toEqual([
        "TOPIK_RESOURCE_REFERENCE_UNRESOLVED",
        "TOPIK_RESOURCE_REFERENCE_UNRESOLVED",
      ]);
      expect(html).not.toContain("ref://");
      expect(html).not.toContain("private route failure");
    },
  );

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

  it("rejects unsafe cards before rendering", () => {
    expect(() =>
      renderToStaticMarkup(
        <TopikContent content='{% card title="Unsafe" href="javascript:alert(1)" /%}' />,
      ),
    ).toThrow(InvalidTopikContentError);
  });

  it("rejects named Asset URLs from navigation-only cards", () => {
    const reference = `asset:auto-v1-${"a".repeat(52)}`;
    const content = `{% card title="Asset" href="${reference}" /%}`;
    const diagnostics: string[] = [];
    expect(() =>
      renderToStaticMarkup(
        <TopikContent
          content={content}
          onDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
        />,
      ),
    ).toThrow(InvalidTopikContentError);
    expect(diagnostics).toContain("link-asset-navigation-unsupported");
  });

  it.each([
    `ASSET:auto-v1-${"a".repeat(52)}`,
    `asset%3Aauto-v1-${"a".repeat(52)}`,
    `%61sset%3Aauto-v1-${"a".repeat(52)}`,
    `asset&#58;auto-v1-${"a".repeat(52)}`,
    "asset:auto-v1-short",
  ])("never passes reserved download alias %s to default or custom renderers", (reference) => {
    const resolver = vi.fn(() => "/must-not-resolve");
    const diagnostics: string[] = [];
    const content = `[Download](${reference})`;
    expect(() =>
      renderToStaticMarkup(
        <TopikContent
          content={content}
          onDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
          resolveAsset={resolver}
        />,
      ),
    ).toThrow(InvalidTopikContentError);
    expect(resolver).not.toHaveBeenCalled();
    expect(diagnostics).toContain("TOPIK_ASSET_REFERENCE_MALFORMED");
  });

  it("resolves a canonical compiled download for default and custom renderers", () => {
    const name = `auto-v1-${"a".repeat(52)}`;
    const resolver = vi.fn(() => `/compiled/${name}`);
    const diagnostics: string[] = [];
    const content = `[Download](asset:${name})`;
    const defaultHtml = renderToStaticMarkup(
      <TopikContent
        content={content}
        onAssetDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
        resolveAsset={resolver}
      />,
    );
    const customHtml = renderToStaticMarkup(
      <TopikContent
        components={{
          TopikLink: ({ children, href }) => (
            <a data-custom href={String(href)}>
              {children}
            </a>
          ),
        }}
        content={content}
        onAssetDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
        resolveAsset={resolver}
      />,
    );

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenNthCalledWith(1, name);
    expect(resolver).toHaveBeenNthCalledWith(2, name);
    expect(diagnostics).toEqual([]);
    expect(defaultHtml).toContain(`href="/compiled/${name}"`);
    expect(customHtml).toContain(`href="/compiled/${name}"`);
  });

  it("uses provider component overrides with portable paths", () => {
    const html = renderToStaticMarkup(
      <TopikContentProvider
        components={{
          TopikFigure: ({ src }) => <span data-provider-src={String(src)} />,
        }}
      >
        <TopikContent content='{% figure src="assets/hero.png" alt="Hero" /%}' />
      </TopikContentProvider>,
    );

    expect(html).toContain('data-provider-src="assets/hero.png"');
  });

  it("keeps default quiz behavior when leaf components are overridden", () => {
    const html = renderToStaticMarkup(
      <TopikContent
        components={{
          TopikChoice: ({ children }) => <span className="custom-choice">{children}</span>,
          TopikExplanation: ({ children }) => <div className="custom-explanation">{children}</div>,
        }}
        content={[
          "{% quiz %}",
          "{% question %}",
          "{% choice correct=true %}",
          "Yes",
          "{% /choice %}",
          "{% choice %}",
          "No",
          "{% /choice %}",
          "{% explanation %}",
          "Because yes.",
          "{% /explanation %}",
          "{% /question %}",
          "{% /quiz %}",
        ].join("\n")}
      />,
    );

    expect(html).toContain("custom-choice");
    expect(html).toContain("Yes");
    expect(html).toContain("No");
    expect(html).toContain('type="radio"');
  });
});

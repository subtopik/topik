import Markdoc from "@markdoc/markdoc";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TopikContentProvider, useTopikComponents } from "./context";
import { getTopikComponents } from "./components";
import {
  compileTopikContent,
  renderTopikContent,
  renderTopikMarkdown,
  resolveTopikAssetReferences,
} from "./render";

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

{% figure src="assets/hero.png" darkSrc="assets/hero-dark.png" alt="Hero" caption="A figure" /%}

Inline {% badge variant="success" %}stable{% /badge %}.

![Logo](assets/logo.png)

{% codeGroup %}
{% codeTab title="pnpm" %}
\`\`\`sh
pnpm install
\`\`\`
{% /codeTab %}
{% /codeGroup %}

{% math content="E = mc^2" /%}

Inline math: {% mathInline content="x^2" /%}

Use {% underline %}important text{% /underline %}.

\`\`\`mermaid
graph TD;
  A-->B;
\`\`\`

| A | B |
| - | - |
| 1 | 2 |

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
  it("resolves names in declared slots during server rendering", () => {
    const assetNames = ["a", "b", "c", "d"].map((character) => `auto-v1-${character.repeat(52)}`);
    const names: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          [
            `![Logo](asset:${assetNames[0]})`,
            `{% figure src="asset:${assetNames[1]}" darkSrc="asset:${assetNames[2]}" alt="Figure" /%}`,
            `[Download](asset:${assetNames[3]})`,
          ].join("\n\n"),
          {
            components: {
              TopikFigure: ({ darkSrc, src }) => (
                <picture>
                  <source srcSet={String(darkSrc)} />
                  <img alt="" src={String(src)} />
                </picture>
              ),
              TopikImage: ({ src }) => <img alt="" src={String(src)} />,
              TopikLink: ({ children, href }) => <a href={String(href)}>{children}</a>,
            },
            resolveAsset: (name) => {
              names.push(name);
              return `/compiled/${name}`;
            },
          },
        )}
      </>,
    );

    expect(names).toEqual(assetNames);
    expect(html).toContain(`src="/compiled/${assetNames[0]}"`);
    expect(html).toContain(`src="/compiled/${assetNames[1]}"`);
    expect(html).toContain(`srcSet="/compiled/${assetNames[2]}"`);
    expect(html).toContain(`href="/compiled/${assetNames[3]}"`);
    expect(html).not.toContain("asset:");
  });

  it("does not recursively rewrite arbitrary strings", () => {
    const tree = new Markdoc.Tag("TopikCard", {
      title: "asset:company-logo",
      data: { nested: "asset:company-logo" },
    });
    const resolver = vi.fn(() => "/compiled/company-logo");

    const resolved = resolveTopikAssetReferences(tree, resolver);

    expect(resolver).not.toHaveBeenCalled();
    expect(resolved.attributes).toEqual(tree.attributes);
  });

  it("fails closed for an unresolved named Asset", () => {
    const name = `auto-v1-${"a".repeat(52)}`;
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(`![Logo](asset:${name})`, {
          resolveAsset: () => undefined,
          onAssetDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );

    expect(diagnostics).toContain("TOPIK_ASSET_REFERENCE_MISSING");
    expect(html).not.toContain("asset:");
    expect(html).not.toMatch(/\bsrc=/u);
  });

  it("fails closed for a malformed named Asset in source and transformed trees", () => {
    const sourceDiagnostics: string[] = [];
    const resolutionDiagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown("![Logo](asset:auto-v1-short)", {
          onDiagnostic: (diagnostic) => sourceDiagnostics.push(diagnostic.id),
        })}
      </>,
    );
    const resolved = resolveTopikAssetReferences(
      new Markdoc.Tag("TopikImage", { src: "asset:auto-v1-short" }),
      () => "/must-not-resolve",
      { onDiagnostic: (diagnostic) => resolutionDiagnostics.push(diagnostic.id) },
    );

    expect(sourceDiagnostics).toContain("TOPIK_ASSET_REFERENCE_MALFORMED");
    expect(resolutionDiagnostics).toContain("TOPIK_ASSET_REFERENCE_MALFORMED");
    expect(resolved.attributes).not.toHaveProperty("src");
    expect(html).not.toContain("asset:");
    expect(html).not.toMatch(/\bsrc=/u);
  });

  it.each([
    `ASSET:auto-v1-${"a".repeat(52)}`,
    `asset%3Aauto-v1-${"a".repeat(52)}`,
    `%61sset%3Aauto-v1-${"a".repeat(52)}`,
    `asset&#58;auto-v1-${"a".repeat(52)}`,
    "asset:auto-v1-short",
  ])("fails closed for reserved Asset alias %s in a transformed download slot", (reference) => {
    const resolver = vi.fn(() => "/must-not-resolve");
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      new Markdoc.Tag("TopikLink", { href: reference }),
      resolver,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolver).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(["TOPIK_ASSET_REFERENCE_MALFORMED"]);
    expect(resolved.attributes).not.toHaveProperty("href");
  });

  it("sanitizes reserved aliases in every rendered Asset-capable slot", () => {
    const reference = `ASSET:auto-v1-${"a".repeat(52)}`;
    const resolver = vi.fn(() => "/must-not-resolve");
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      [
        new Markdoc.Tag("TopikImage", { src: reference }),
        new Markdoc.Tag("TopikFigure", { src: reference, darkSrc: reference }),
        new Markdoc.Tag("TopikLink", { href: reference }),
      ],
      resolver,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolver).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
    expect(resolved.map((tag) => tag.attributes)).toEqual([{}, {}, {}]);
  });

  it.each([
    "http://example.com/file.png",
    "HtTp://example.com/file.png",
    "https://user:secret@example.com/file.png",
    "//example.com/file.png",
    "javascript:alert(1)",
    "data:image/png;base64,AA==",
    "file:///tmp/file.png",
    "asset:auto-v1-short",
    `ASSET:auto-v1-${"a".repeat(52)}`,
  ])("removes unsafe post-transform value %s from every Asset slot", (reference) => {
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      [
        new Markdoc.Tag("TopikImage", { src: reference }),
        new Markdoc.Tag("TopikFigure", { src: reference, darkSrc: reference }),
        new Markdoc.Tag("TopikLink", { href: reference }),
      ],
      undefined,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolved.map((tag) => tag.attributes)).toEqual([{}, {}, {}]);
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
  });

  it.each([
    ["coercible object", { toString: () => "https://user:secret@example.com/file.png" }],
    ["boxed string", Object("https://user:secret@example.com/file.png")],
    ["array", ["https://user:secret@example.com/file.png"]],
    ["number", 42],
    ["boolean", true],
    ["null", null],
  ])("omits and diagnoses a transformed %s in every Asset slot", (_kind, value) => {
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      [
        new Markdoc.Tag("TopikImage", { src: value }),
        new Markdoc.Tag("TopikFigure", { src: value, darkSrc: value }),
        new Markdoc.Tag("TopikLink", { href: value }),
      ],
      undefined,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolved.map((tag) => tag.attributes)).toEqual([{}, {}, {}]);
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
  });

  it("omits non-string values before the fallback renderer receives them", () => {
    const diagnostics: string[] = [];
    expect(() =>
      renderToStaticMarkup(
        <>
          {renderTopikContent(
            new Markdoc.Tag("article", {}, [
              new Markdoc.Tag("TopikImage", { src: { toString: () => "unsafe-image" } }),
              new Markdoc.Tag("TopikFigure", { darkSrc: Object("unsafe-dark"), src: 1 }),
              new Markdoc.Tag("TopikLink", { href: null }, ["Download"]),
            ]),
            { onAssetDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
          )}
        </>,
      ),
    ).not.toThrow();
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
  });

  it.each([true, false])(
    "sanitizes variable and function results before custom renderers with validation %s",
    (validate) => {
      const diagnostics: string[] = [];
      const html = renderToStaticMarkup(
        <>
          {renderTopikMarkdown(
            [
              '{% evaluatedImage src=$unsafe alt="Image" /%}',
              '{% figure src=unsafe() darkSrc=$allowed alt="Figure" /%}',
              "{% evaluatedLink href=$unsafe %}Download{% /evaluatedLink %}",
            ].join("\n\n"),
            {
              components: {
                TopikFigure: ({ darkSrc, src }) => (
                  <span data-dark={String(darkSrc)} data-src={String(src)} />
                ),
                TopikImage: ({ src }) => <span data-src={String(src)} />,
                TopikLink: ({ children, href }) =>
                  typeof href === "string" ? (
                    <a data-custom href={href}>
                      {children}
                    </a>
                  ) : (
                    <span data-no-target>{children}</span>
                  ),
              },
              config: {
                functions: { unsafe: { transform: () => "javascript:alert(1)" } },
                tags: {
                  evaluatedImage: {
                    render: "TopikImage",
                    attributes: { alt: { type: String }, src: { type: String } },
                  },
                  evaluatedLink: {
                    render: "TopikLink",
                    attributes: { href: { type: String } },
                  },
                },
                variables: {
                  allowed: "HtTpS://example.com/dark.png",
                  unsafe: "http://example.com/file.png",
                },
              },
              onAssetDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
              validate,
            },
          )}
        </>,
      );

      expect(diagnostics).toEqual(Array(3).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
      expect(html).toContain('data-dark="HtTpS://example.com/dark.png"');
      expect(html).not.toContain("http://");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("href=");
      expect(html).toContain("data-no-target");
    },
  );

  it.each([true, false])(
    "omits coercible non-string variable and function results before custom renderers with validation %s",
    (validate) => {
      const unsafe = "https://user:secret@example.com/file.png";
      const diagnostics: string[] = [];
      const html = renderToStaticMarkup(
        <>
          {renderTopikMarkdown(
            [
              '{% evaluatedImage src=$object alt="Object" /%}',
              '{% figure src=boxed() darkSrc=$array alt="Figure" /%}',
              "{% evaluatedLink href=number() %}Number{% /evaluatedLink %}",
              '{% evaluatedImage src=$boolean alt="Boolean" /%}',
              "{% evaluatedLink href=nil() %}Null{% /evaluatedLink %}",
              '{% evaluatedImage src=$allowed alt="Allowed" /%}',
            ].join("\n\n"),
            {
              components: {
                TopikFigure: ({ darkSrc, src }) => (
                  <span data-dark={String(darkSrc)} data-src={String(src)} />
                ),
                TopikImage: ({ src }) => <span data-src={String(src)} />,
                TopikLink: ({ children, href }) => (
                  <a data-custom href={String(href)}>
                    {children}
                  </a>
                ),
              },
              config: {
                functions: {
                  boxed: { transform: () => Object(unsafe) },
                  nil: { transform: () => null },
                  number: { transform: () => 42 },
                },
                tags: {
                  evaluatedImage: {
                    render: "TopikImage",
                    attributes: { alt: { type: String }, src: { type: Object } },
                  },
                  evaluatedLink: {
                    render: "TopikLink",
                    attributes: { href: { type: Object } },
                  },
                },
                variables: {
                  allowed: "images/allowed.png",
                  array: [unsafe],
                  boolean: true,
                  object: { toString: () => unsafe },
                },
              },
              onAssetDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
              validate,
            },
          )}
        </>,
      );

      expect(diagnostics).toEqual(Array(6).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
      expect(html).toContain('data-src="images/allowed.png"');
      expect(html).not.toContain("user:secret");
      expect(html).not.toContain('href="42"');
      expect(html).not.toContain('href="null"');
      expect(html).not.toContain('data-src="true"');
    },
  );

  it("preserves safe evaluated navigation and Asset values", () => {
    const references = [
      "guide?tab=api#install",
      "#install",
      "/guide?tab=api#install",
      "mailto:docs@example.com",
      "HtTpS://example.com/file.pdf",
    ];
    const resolved = resolveTopikAssetReferences(
      references.map((href) => new Markdoc.Tag("TopikLink", { href })),
    );
    expect(resolved.map((tag) => tag.attributes.href)).toEqual(references);
    expect(
      resolveTopikAssetReferences(
        new Markdoc.Tag("TopikFigure", {
          darkSrc: "HtTpS://example.com/dark.png",
          src: "images/light.png",
        }),
      ).attributes,
    ).toEqual({ darkSrc: "HtTpS://example.com/dark.png", src: "images/light.png" });
  });

  it.each([
    "http://example.com/file.png",
    "https://user:secret@example.com/file.png",
    "//example.com/file.png",
    "javascript:alert(1)",
    `ASSET:auto-v1-${"b".repeat(52)}`,
  ])("does not emit unsafe Asset resolver result %s", (resolvedReference) => {
    const name = `auto-v1-${"a".repeat(52)}`;
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      new Markdoc.Tag("TopikImage", { src: `asset:${name}` }),
      () => resolvedReference,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolved.attributes).not.toHaveProperty("src");
    expect(diagnostics).toEqual(["TOPIK_ASSET_REFERENCE_MISSING"]);
  });

  it.each([
    `ASSET:auto-v1-${"b".repeat(52)}`,
    `asset%3Aauto-v1-${"b".repeat(52)}`,
    `asset&#58;auto-v1-${"b".repeat(52)}`,
  ])("does not emit reserved alias %s returned by an Asset resolver", (resolvedReference) => {
    const name = `auto-v1-${"a".repeat(52)}`;
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      new Markdoc.Tag("TopikLink", { href: `asset:${name}` }),
      () => resolvedReference,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(diagnostics).toEqual(["TOPIK_ASSET_REFERENCE_MISSING"]);
    expect(resolved.attributes).not.toHaveProperty("href");
  });

  it("fails closed when a runtime Asset resolver returns a non-string value", () => {
    const name = `auto-v1-${"a".repeat(52)}`;
    const diagnostics: string[] = [];
    const resolved = resolveTopikAssetReferences(
      [
        new Markdoc.Tag("TopikImage", { src: `asset:${name}` }),
        new Markdoc.Tag("TopikFigure", {
          darkSrc: `asset:${name}`,
          src: `asset:${name}`,
        }),
        new Markdoc.Tag("TopikLink", { href: `asset:${name}` }),
      ],
      () => Object("https://user:secret@example.com/file.png") as string,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id) },
    );

    expect(resolved.map((tag) => tag.attributes)).toEqual([{}, {}, {}]);
    expect(diagnostics).toEqual(Array(4).fill("TOPIK_ASSET_REFERENCE_MISSING"));
  });

  it("renders basic markdown nodes", () => {
    const html = renderToStaticMarkup(<>{renderTopikMarkdown("# Hello\n\nParagraph.")}</>);

    expect(html).toContain('<h1 id="hello">Hello</h1>');
    expect(html).toContain("<p>Paragraph.</p>");
  });

  it("renders generated, duplicate, and explicit heading IDs", () => {
    const html = renderToStaticMarkup(
      <>{renderTopikMarkdown("## Setup\n\n## Setup\n\n## Introduction {% #start-here %}")}</>,
    );

    expect(html).toContain('<h2 id="setup">Setup</h2>');
    expect(html).toContain('<h2 id="setup-1">Setup</h2>');
    expect(html).toContain('<h2 id="start-here">Introduction ');
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
      TopikCodeBlock: ({ content, language }) => (
        <pre data-code-block={String(language)}>{String(content)}</pre>
      ),
      TopikCodeGroup: ({ children }) => <div data-code-group>{children}</div>,
      TopikCodeTab: ({ children, title }) => (
        <section data-code-tab={String(title)}>{children}</section>
      ),
      TopikChoice: ({ children }) => <div data-choice>{children}</div>,
      TopikExplanation: ({ children }) => <div data-explanation>{children}</div>,
      TopikFigure: ({ src }) => <img alt="" src={String(src)} />,
      TopikImage: ({ src }) => <img alt="" data-image src={String(src)} />,
      TopikInlineCode: ({ children }) => <code data-inline-code>{children}</code>,
      TopikLink: ({ children, href }) => (
        <a data-link href={String(href)}>
          {children}
        </a>
      ),
      TopikMath: ({ content }) => <div data-math>{String(content)}</div>,
      TopikMathInline: ({ content }) => <span data-math-inline>{String(content)}</span>,
      TopikMermaid: ({ content }) => <div data-mermaid>{String(content)}</div>,
      TopikQuestion: ({ children }) => <div data-question>{children}</div>,
      TopikQuiz: ({ children }) => <div data-quiz>{children}</div>,
      TopikStep: ({ children, title }) => <li data-step={String(title)}>{children}</li>,
      TopikSteps: ({ children }) => <ol data-steps>{children}</ol>,
      TopikTab: ({ children, title }) => <section data-tab={String(title)}>{children}</section>,
      TopikTabs: ({ children }) => <div data-tabs>{children}</div>,
      TopikTable: ({ children }) => <table data-table>{children}</table>,
      TopikTableCell: ({ children }) => <td data-table-cell>{children}</td>,
      TopikTableHeader: ({ children }) => <th data-table-header>{children}</th>,
      TopikTableRow: ({ children }) => <tr data-table-row>{children}</tr>,
      TopikUnderline: ({ children }) => <u data-underline>{children}</u>,
    });
    const html = renderToStaticMarkup(
      <>{renderTopikMarkdown(allComponentsContent, { components })}</>,
    );

    expect(html).toContain('data-callout="Remember"');
    expect(html).toContain("data-card-grid");
    expect(html).toContain('data-card="One"');
    expect(html).toContain('data-accordion="Details"');
    expect(html).toContain("data-tabs");
    expect(html).toContain('data-tab="A"');
    expect(html).toContain("data-code-group");
    expect(html).toContain('data-code-tab="pnpm"');
    expect(html).toContain('data-code-block="sh"');
    expect(html).toContain("data-steps");
    expect(html).toContain('data-step="Install"');
    expect(html).toContain('src="assets/hero.png"');
    expect(html).toContain('src="assets/logo.png"');
    expect(html).toContain("<mark>stable</mark>");
    expect(html).toContain("data-math");
    expect(html).toContain("data-math-inline");
    expect(html).toContain("data-mermaid");
    expect(html).toContain("data-underline");
    expect(html).toContain("data-table");
    expect(html).toContain("data-table-row");
    expect(html).toContain("data-table-cell");
    expect(html).toContain("data-table-header");
    expect(html).toContain("data-quiz");
    expect(html).toContain("data-question");
    expect(html).toContain("data-choice");
    expect(html).toContain("data-explanation");
  });

  it("provides components through context while preserving portable paths", () => {
    function ContextRenderer() {
      const components = useTopikComponents();

      return (
        <>
          {renderTopikMarkdown('{% figure src="assets/logo.svg" alt="Logo" /%}', {
            components,
          })}
        </>
      );
    }

    const html = renderToStaticMarkup(
      <TopikContentProvider
        components={{
          TopikFigure: ({ src }) => <span data-src={String(src)} />,
        }}
      >
        <ContextRenderer />
      </TopikContentProvider>,
    );

    expect(html).toContain('data-src="assets/logo.svg"');
  });

  it("reports validation diagnostics", () => {
    const diagnostics: string[] = [];

    const rendered = renderTopikMarkdown("{% quiz %}{% /quiz %}", {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });

    expect(rendered).toBeDefined();
    expect(diagnostics.some((message) => message.includes("'quiz' requires"))).toBe(true);
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
  ])("diagnoses and removes unsafe asset reference %s before rendering", (reference) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(`{% figure src="${reference}" alt="Unsafe" /%}`, {
          components: {
            TopikFigure: ({ darkSrc, src }) =>
              typeof src === "string" ? (
                <picture>
                  {typeof darkSrc === "string" ? <source srcSet={darkSrc} /> : null}
                  <img alt="" src={src} />
                </picture>
              ) : null,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^TOPIK_(?:ASSET_PATH_INVALID|EXTERNAL_REFERENCE_UNSAFE)$/u),
      ]),
    );
    expect(html).not.toContain(reference);
    expect(html).not.toMatch(/\b(?:src|srcset|href)="/iu);
    expect(html).not.toContain('rel="preload"');
  });

  it.each([
    "![Unsafe][id]\n\n[id]:\n  é.png\n",
    '![Unsafe][id]\n\n[id]:\n  &eacute;.png\n  "Title"\n',
  ])("does not render a parser-normalized continuation destination", (content) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("does not render a raw non-ASCII Markdown destination after parser normalization", () => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown("![Unsafe](é.png)", {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
  });

  it("does not render a raw non-ASCII reference-style image destination", () => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown("![Unsafe][id]\n\n[id]: é.png\n", {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("does not render a destination proved only by an unrelated Markdoc attribute", () => {
    const diagnostics: string[] = [];
    const source =
      '![x][id] {% callout title="![x](%C3%A9.png)" %}foo{% /callout %}\n\n> [id]: é.png';
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(source, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
  });

  it.each([
    "![Unsafe](&eacute;.png)\n",
    "![Unsafe][id]\n\n[id]: &eacute;.png\n",
    "![Unsafe](hero\\.png)\n",
  ])("does not render a parser-unescaped source destination", (content) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it.each([
    "![Nested [unsafe]](é.png)\n",
    "![Nested [unsafe]](&eacute;.png)\n",
    "![Nested [unsafe]](hero\\.png)\n",
    "![Nested [unsafe]][id]\n\n[id]: é.png\n",
    "![Nested [unsafe]][id]\n\n[id]: &eacute;.png\n",
    "![Nested [unsafe]][id]\n\n[id]: hero\\.png\n",
    "[![Nested image](é.png)](manual.bin)\n",
  ])("does not render a noncanonical destination behind a nested label", (content) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("renders canonical encoded image destinations behind nested labels", () => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          "![Inline [safe]](%C3%A9.png)\n\n![Reference [safe]][id]\n\n[id]: %C3%A9.png\n",
          {
            components: {
              TopikImage: ({ src }) => <img alt="" src={String(src)} />,
            },
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
          },
        )}
      </>,
    );
    expect(diagnostics).toEqual([]);
    expect(html.match(/src="%C3%A9\.png"/gu)).toHaveLength(2);
  });

  it.each([
    "![Inline `]`](é.png)\n",
    "![Inline `[`](&eacute;.png)\n",
    "![Inline `]`](hero\\.png)\n",
    "![Reference `]`][id]\n\n[id]: é.png\n",
    "![Reference `[`][id]\n\n[id]: &eacute;.png\n",
    "![Reference `]`][id]\n\n[id]: hero\\.png\n",
  ])("does not render a noncanonical destination behind a code-span label", (content) => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_ASSET_PATH_INVALID");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("renders canonical encoded image destinations behind code-span labels", () => {
    const diagnostics: string[] = [];
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          "![Inline `]`](%C3%A9.png)\n\n![Reference `[`][id]\n\n[id]: %C3%A9.png\n",
          {
            components: {
              TopikImage: ({ src }) => <img alt="" src={String(src)} />,
            },
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
          },
        )}
      </>,
    );
    expect(diagnostics).toEqual([]);
    expect(html.match(/src="%C3%A9\.png"/gu)).toHaveLength(2);
  });

  it("does not render a multiline external entity by borrowing an escaped construct", () => {
    const diagnostics: string[] = [];
    const source =
      "![Multiline](\n  https://example.com/a&amp;b\n) \\![fake](https://example.com/a&b)";
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(source, {
          components: {
            TopikImage: ({ src }) =>
              typeof src === "string" ? <img alt="" data-unsafe src={src} /> : null,
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
        })}
      </>,
    );
    expect(diagnostics).toContain("TOPIK_EXTERNAL_REFERENCE_UNSAFE");
    expect(html).not.toContain("data-unsafe");
    expect(html).not.toMatch(/\bsrc=/u);
    expect(html).not.toContain('rel="preload"');
  });

  it("renders canonical local and allowed external HTTPS asset references", () => {
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          '{% figure src="assets/caf%C3%A9.png" darkSrc="https://example.com/dark.png?q=1#x" alt="Hero" /%}',
          {
            components: {
              TopikFigure: ({ darkSrc, src }) => (
                <picture>
                  <source srcSet={String(darkSrc)} />
                  <img alt="" src={String(src)} />
                </picture>
              ),
            },
          },
        )}
      </>,
    );
    expect(html).toContain('src="assets/caf%C3%A9.png"');
    expect(html).toContain('srcSet="https://example.com/dark.png?q=1#x"');
  });

  it.each([true, false])(
    "preserves mixed-case HTTPS through custom renderers with validation=%s",
    (validate) => {
      const content = [
        "![Image](HtTpS://example.com/image.png)",
        "[Download](hTTps://example.com/manual.pdf)",
        "<HTTPS://example.com/autolink.pdf>",
        '{% figure src="HTtPs://example.com/light.png" darkSrc="htTPs://example.com/dark.png" alt="Theme" /%}',
      ].join("\n\n");
      const customHtml = renderToStaticMarkup(
        <>
          {renderTopikMarkdown(content, {
            validate,
            components: {
              TopikImage: ({ src }) => <span data-image={String(src)} />,
              TopikLink: ({ href }) => <span data-link={String(href)} />,
              TopikFigure: ({ darkSrc, src }) => (
                <span data-dark={String(darkSrc)} data-light={String(src)} />
              ),
            },
          })}
        </>,
      );

      for (const reference of [
        "HtTpS://example.com/image.png",
        "hTTps://example.com/manual.pdf",
        "HTTPS://example.com/autolink.pdf",
        "HTtPs://example.com/light.png",
        "htTPs://example.com/dark.png",
      ]) {
        expect(customHtml).toContain(reference);
      }
    },
  );

  it.each([true, false])(
    "removes mixed-case HTTP and credential-bearing HTTPS with validation=%s",
    (validate) => {
      const diagnostics: string[] = [];
      const html = renderToStaticMarkup(
        <>
          {renderTopikMarkdown(
            [
              "![HTTP](HtTp://example.com/image.png)",
              "[HTTP](hTtP://example.com/manual.pdf)",
              "<HTtp://example.com/autolink.pdf>",
              '{% figure src="hTtPs://user:secret@example.com/image.png" alt="Unsafe" /%}',
              "![Protocol relative](//example.com/image.png)",
              '{% figure src="HtTpS://[invalid" alt="Malformed" /%}',
            ].join("\n\n"),
            {
              validate,
              components: {
                TopikImage: ({ src }) => <span data-image={String(src)} />,
                TopikFigure: ({ src }) => <span data-figure={String(src)} />,
              },
              onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.id),
            },
          )}
        </>,
      );

      expect(html).not.toContain('data-image="HtTp:');
      expect(html).not.toContain('data-link="hTtP:');
      expect(html).not.toContain('data-link="HTtp:');
      expect(html).not.toContain("user:secret");
      expect(html).not.toContain('data-image="//example.com');
      expect(html).not.toContain('data-figure="HtTpS://[invalid');
      expect(html).not.toMatch(/\b(?:src|href)="/iu);
      if (validate) expect(diagnostics).toContain("TOPIK_EXTERNAL_REFERENCE_UNSAFE");
    },
  );

  it.each([true, false])(
    "preserves ordinary navigation with query and fragment when validation=%s",
    (validate) => {
      const href = "guide?tab=assets#delivery";
      const html = renderToStaticMarkup(
        <>
          {renderTopikMarkdown(`[Guide](${href})`, {
            validate,
            components: {
              TopikLink: ({ children, href: target }) => <a href={String(target)}>{children}</a>,
            },
          })}
        </>,
      );

      expect(html).toContain(`href="${href}"`);
    },
  );

  it("server-renders compiled content without crashing", () => {
    const tree = compileTopikContent('{% callout title="SSR" %}Works.{% /callout %}');
    const html = renderToString(<>{renderTopikContent(tree)}</>);

    expect(tree).toBeTruthy();
    expect(html).toContain("Works.");
  });

  it("renders portable resource-root-relative references offline without a host resolver", () => {
    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(
          '![Offline hero](assets/getting-started/hero.png)\n\n{% figure src="assets/light.png" darkSrc="assets/dark.png" alt="Theme" /%}',
          {
            components: {
              TopikImage: ({ alt, src }) => <img alt={String(alt)} src={String(src)} />,
              TopikFigure: ({ alt, darkSrc, src }) => (
                <picture data-dark-src={String(darkSrc)}>
                  <img alt={String(alt)} src={String(src)} />
                </picture>
              ),
            },
          },
        )}
      </>,
    );

    expect(html).toContain('src="assets/getting-started/hero.png"');
    expect(html).toContain('src="assets/light.png"');
    expect(html).toContain('data-dark-src="assets/dark.png"');
  });
});

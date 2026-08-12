import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { TopikContentProvider } from "../core/context";
import type { TopikLinkRenderProps } from "../core/components";
import { TopikContent } from "./TopikContent";

describe("TopikContent", () => {
  it("renders styled default components with portable asset paths", () => {
    const html = renderToStaticMarkup(
      <TopikContent content='{% callout title="Asset" %}{% figure src="assets/hero.webp" alt="Hero" /%}{% /callout %}' />,
    );

    expect(html).toContain('class="topik-content"');
    expect(html).toContain('class="topik-callout not-prose"');
    expect(html).toContain('src="assets/hero.webp"');
  });

  it.each([true, false])(
    "preserves mixed-case credential-free HTTPS in the default renderer with validation=%s",
    (validate) => {
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
          validate={validate}
        />,
      );

      for (const reference of references) expect(html).toContain(reference);
    },
  );

  it.each([true, false])(
    "removes mixed-case unsafe external media in the default renderer with validation=%s",
    (validate) => {
      const html = renderToStaticMarkup(
        <TopikContent
          content={[
            "![HTTP](HtTp://example.com/image.png)",
            "[HTTP](hTtP://example.com/manual.pdf)",
            "<HTtp://example.com/autolink.pdf>",
            '{% figure src="hTtPs://user:secret@example.com/image.png" alt="Unsafe" /%}',
            "![Protocol relative](//example.com/image.png)",
            '{% figure src="HtTpS://[invalid" alt="Malformed" /%}',
          ].join("\n\n")}
          validate={validate}
        />,
      );

      expect(html).not.toContain('src="HtTp:');
      expect(html).not.toContain('href="hTtP:');
      expect(html).not.toContain('href="HTtp:');
      expect(html).not.toContain("user:secret");
      expect(html).not.toContain('src="//example.com');
      expect(html).not.toContain('src="HtTpS://[invalid');
      expect(html).not.toMatch(/\b(?:src|href)="/iu);
    },
  );

  it.each([true, false])(
    "removes unsafe evaluated Asset-slot values in the default renderer with validation=%s",
    (validate) => {
      const diagnostics: string[] = [];
      const html = renderToStaticMarkup(
        <TopikContent
          config={{
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
              unsafe: "https://user:secret@example.com/file.png",
            },
          }}
          content={[
            '{% evaluatedImage src=$unsafe alt="Image" /%}',
            '{% figure src=$allowed darkSrc=unsafe() alt="Figure" /%}',
            "{% evaluatedLink href=$unsafe %}Download{% /evaluatedLink %}",
          ].join("\n\n")}
          onAssetDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
          validate={validate}
        />,
      );

      expect(diagnostics).toEqual(Array(3).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
      expect(html).toContain("HtTpS://example.com/dark.png");
      expect(html).not.toContain("user:secret");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("href=");
    },
  );

  it.each([true, false])(
    "omits non-string evaluated Asset-slot values in the themed renderer with validation=%s",
    (validate) => {
      const unsafe = "https://user:secret@example.com/file.png";
      const diagnostics: string[] = [];
      const html = renderToStaticMarkup(
        <TopikContent
          config={{
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
          }}
          content={[
            '{% evaluatedImage src=$object alt="Object" /%}',
            '{% figure src=boxed() darkSrc=$array alt="Figure" /%}',
            "{% evaluatedLink href=number() %}Number{% /evaluatedLink %}",
            '{% evaluatedImage src=$boolean alt="Boolean" /%}',
            "{% evaluatedLink href=nil() %}Null{% /evaluatedLink %}",
            '{% evaluatedImage src=$allowed alt="Allowed" /%}',
          ].join("\n\n")}
          onAssetDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
          validate={validate}
        />,
      );

      expect(diagnostics).toEqual(Array(6).fill("TOPIK_ASSET_REFERENCE_MALFORMED"));
      expect(html).toContain('src="images/allowed.png"');
      expect(html).not.toContain("user:secret");
      expect(html).not.toContain('href="42"');
      expect(html).not.toContain('href="null"');
      expect(html).not.toContain('src="true"');
    },
  );

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

  it("never emits named Asset URLs from default or custom navigation-only cards", () => {
    const reference = `asset:auto-v1-${"a".repeat(52)}`;
    const content = `{% card title="Asset" href="${reference}" /%}`;
    const diagnostics: string[] = [];
    const defaultHtml = renderToStaticMarkup(
      <TopikContent
        content={content}
        onDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
      />,
    );
    const customHtml = renderToStaticMarkup(
      <TopikContent
        components={{
          TopikCard: ({ href }) =>
            typeof href === "string" ? <a href={href}>Asset</a> : <span>No target</span>,
        }}
        content={content}
        validate={false}
      />,
    );
    expect(diagnostics).toContain("link-asset-navigation-unsupported");
    expect(defaultHtml).not.toContain(reference);
    expect(defaultHtml).not.toContain("href=");
    expect(customHtml).toContain("No target");
    expect(customHtml).not.toContain(reference);
    expect(customHtml).not.toContain("href=");
  });

  it.each([
    `ASSET:auto-v1-${"a".repeat(52)}`,
    `asset%3Aauto-v1-${"a".repeat(52)}`,
    `%61sset%3Aauto-v1-${"a".repeat(52)}`,
    `asset&#58;auto-v1-${"a".repeat(52)}`,
    "asset:auto-v1-short",
  ])("never passes reserved download alias %s to default or custom renderers", (reference) => {
    for (const validate of [true, false]) {
      const resolver = vi.fn(() => "/must-not-resolve");
      const diagnostics: string[] = [];
      const content = `[Download](${reference})`;
      const defaultHtml = renderToStaticMarkup(
        <TopikContent
          content={content}
          onAssetDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
          resolveAsset={resolver}
          validate={validate}
        />,
      );
      const customHtml = renderToStaticMarkup(
        <TopikContent
          components={{
            TopikLink: ({ children, href }) =>
              typeof href === "string" ? (
                <a data-custom href={href}>
                  {children}
                </a>
              ) : (
                <span data-no-target>{children}</span>
              ),
          }}
          content={content}
          onAssetDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
          resolveAsset={resolver}
          validate={validate}
        />,
      );

      expect(resolver).not.toHaveBeenCalled();
      expect(diagnostics).toEqual([
        "TOPIK_ASSET_REFERENCE_MALFORMED",
        "TOPIK_ASSET_REFERENCE_MALFORMED",
      ]);
      expect(defaultHtml).not.toContain("href=");
      expect(defaultHtml).not.toContain(reference);
      expect(customHtml).toContain("data-no-target");
      expect(customHtml).not.toContain("href=");
      expect(customHtml).not.toContain(reference);
    }
  });

  it.each([true, false])(
    "resolves a canonical compiled download for default and custom renderers with validation %s",
    (validate) => {
      const name = `auto-v1-${"a".repeat(52)}`;
      const resolver = vi.fn(() => `/compiled/${name}`);
      const diagnostics: string[] = [];
      const content = `[Download](asset:${name})`;
      const defaultHtml = renderToStaticMarkup(
        <TopikContent
          content={content}
          onAssetDiagnostic={(diagnostic) => diagnostics.push(diagnostic.id)}
          resolveAsset={resolver}
          validate={validate}
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
          validate={validate}
        />,
      );

      expect(resolver).toHaveBeenCalledTimes(2);
      expect(resolver).toHaveBeenNthCalledWith(1, name);
      expect(resolver).toHaveBeenNthCalledWith(2, name);
      expect(diagnostics).toEqual([]);
      expect(defaultHtml).toContain(`href="/compiled/${name}"`);
      expect(customHtml).toContain(`href="/compiled/${name}"`);
    },
  );

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
        content="{% quiz %}{% question %}{% choice correct=true %}Yes{% /choice %}{% choice %}No{% /choice %}{% explanation %}Because yes.{% /explanation %}{% /question %}{% /quiz %}"
      />,
    );

    expect(html).toContain("custom-choice");
    expect(html).toContain("Yes");
    expect(html).toContain("No");
    expect(html).toContain('type="radio"');
  });
});

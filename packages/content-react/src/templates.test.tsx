import { ContentTag, compileTopikContent, type RenderableTreeNode } from "@topik/content";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { TopikComponentProps } from "./core/components";
import { InvalidTopikContentError, renderTopikMarkdown } from "./core/render";
import { RichTopikContentProvider } from "./rich";
import { TopikContent } from "./theme/TopikContent";

const value = '<b>& " {% $next %}</b>';
const source = [
  '{% callout title=t"Install {% $name %}" %}',
  "Instructions.",
  "{% /callout %}",
  "",
  '{% figure src="hero.png" alt=t"{% $name %}" caption=t"{% $name %}" /%}',
  "",
  "{% template code %}",
  "```text",
  String.raw`C:\Users\{% $name %}`,
  "literal: {%% $name %}",
  "```",
  "{% /template code %}",
].join("\n");
const code = "C:\\Users\\" + value + "\nliteral: {% $name %}\n";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

function tags(tree: RenderableTreeNode): ContentTag[] {
  if (Array.isArray(tree)) return tree.flatMap(tags);
  if (!(tree instanceof ContentTag)) return [];
  return [tree, ...tree.children.flatMap(tags)];
}

function parseHtml(html: string): HTMLDivElement {
  const dom = document.createElement("div");
  dom.innerHTML = html;
  return dom;
}

function mount(element: ReactNode): HTMLDivElement {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("template reader boundaries", () => {
  it("compiles raw scalar strings without recursively evaluating their delimiters", () => {
    const result = compileTopikContent(source, { config: { variables: { name: value } } });

    expect(result).toMatchObject({ ok: true, source, diagnostics: [] });
    if (!result.ok) throw new Error("Expected supported template source");
    const nodes = tags(result.tree);
    expect(nodes.find((node) => node.name === "TopikCallout")?.attributes.title).toBe(
      `Install ${value}`,
    );
    expect(nodes.find((node) => node.name === "TopikFigure")?.attributes).toMatchObject({
      src: "hero.png",
      alt: value,
      caption: value,
    });
    expect(nodes.find((node) => node.name === "TopikCodeBlock")?.attributes.content).toBe(code);
    expect(result.source).toContain('title=t"Install {% $name %}"');
  });

  it.each([renderToStaticMarkup, renderToString])(
    "server-renders plain templates with exactly one browser escaping layer",
    (render) => {
      const html = render(
        <TopikContent content={source} config={{ variables: { name: value } }} />,
      );
      const dom = parseHtml(html);

      expect(dom.querySelector(".topik-callout__title")?.textContent).toBe(`Install ${value}`);
      expect(dom.querySelector("img")?.getAttribute("alt")).toBe(value);
      expect(dom.querySelector("figcaption")?.textContent).toBe(value);
      expect(dom.querySelector("pre code")?.textContent).toBe(code);
      expect(dom.querySelector("b")).toBeNull();
      expect(html).toContain("&lt;b&gt;&amp;");
      expect(html).not.toContain("&amp;lt;b&amp;gt;");
    },
  );

  it("retains explicit empty props and empty code after null substitution", () => {
    const emptySource = [
      '{% callout title=t"{% $empty %}" %}',
      "Instructions.",
      "{% /callout %}",
      '{% figure src="hero.png" alt=t"{% $empty %}" caption=t"{% $empty %}" /%}',
      "{% template code %}",
      "```text",
      "{% $empty %}",
      "```",
      "{% /template code %}",
    ].join("\n");
    const title = vi.fn(({ title }: TopikComponentProps) => (
      <span data-title={typeof title === "string" ? title : "fallback"} />
    ));
    const html = renderToStaticMarkup(
      <TopikContent
        content={emptySource}
        config={{ variables: { empty: null } }}
        components={{ TopikCallout: title }}
      />,
    );

    expect(title).toHaveBeenCalledWith(expect.objectContaining({ title: "" }), undefined);
    expect(parseHtml(html).querySelector("[data-title]")?.getAttribute("data-title")).toBe("");
    expect(parseHtml(html).querySelector("pre code")?.textContent).toBe("\n");
    expect(parseHtml(html).querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("resolves only the selected branch while preserving reader failures for missing values", () => {
    const conditional = [
      "{% if $visible %}",
      '{% callout title=t"{% $name %}" %}',
      "Selected.",
      "{% /callout %}",
      "{% else /%}",
      "{% template code %}",
      "```text",
      "{% $missing.name %}",
      "```",
      "{% /template code %}",
      "{% /if %}",
    ].join("\n");
    const html = renderToStaticMarkup(
      <TopikContent
        content={conditional}
        config={{ variables: { visible: true, name: "Selected title" } }}
      />,
    );
    expect(parseHtml(html).querySelector(".topik-callout__title")?.textContent).toBe(
      "Selected title",
    );
    expect(html).not.toContain("missing.name");

    const failed = compileTopikContent(conditional, { config: { variables: { visible: false } } });
    expect(failed).toMatchObject({
      ok: false,
      source: conditional,
      diagnostics: [expect.objectContaining({ id: "topik-template-variable-missing" })],
    });
    expect(failed).not.toHaveProperty("tree");
  });

  it("resolves only static reference slots when template values resemble named assets", () => {
    const staticName = `auto-v1-${"a".repeat(52)}`;
    const textName = `auto-v1-${"b".repeat(51)}a`;
    const assetText = `asset:${textName}`;
    const assetSource = [
      `{% figure src="asset:${staticName}" alt=t"{% $name %}" caption=t"{% $name %}" /%}`,
      "{% template code %}",
      "```text",
      "{% $name %}",
      "```",
      "{% /template code %}",
    ].join("\n");
    const resolveAsset = vi.fn(() => "/compiled/hero.png");
    const html = renderToStaticMarkup(
      <TopikContent
        content={assetSource}
        config={{ variables: { name: assetText } }}
        resolveAsset={resolveAsset}
      />,
    );
    const dom = parseHtml(html);

    expect(resolveAsset).toHaveBeenCalledTimes(1);
    expect(resolveAsset).toHaveBeenCalledWith(staticName);
    expect(dom.querySelector("img")?.getAttribute("src")).toBe("/compiled/hero.png");
    expect(dom.querySelector("img")?.getAttribute("alt")).toBe(assetText);
    expect(dom.querySelector("figcaption")?.textContent).toBe(assetText);
    expect(dom.querySelector("pre code")?.textContent).toBe(`${assetText}\n`);
  });

  it("rejects malformed template source in an inactive branch before rendering", () => {
    const conditional = [
      "{% if $visible %}",
      '{% callout title=t"{% $name %}" %}',
      "Selected.",
      "{% /callout %}",
      "{% else /%}",
      "{% template code %}",
      "```text",
      "{% $invalid[0] %}",
      "```",
      "{% /template code %}",
      "{% /if %}",
    ].join("\n");
    const renderCallout = vi.fn(() => <aside>Selected</aside>);
    const config = { variables: { visible: true, name: "Selected title" } };

    expect(compileTopikContent(conditional, { config })).toMatchObject({
      ok: false,
      source: conditional,
      diagnostics: [expect.objectContaining({ id: "topik-template-syntax" })],
    });
    expect(() =>
      renderToStaticMarkup(
        <TopikContent
          content={conditional}
          config={config}
          components={{ TopikCallout: renderCallout }}
        />,
      ),
    ).toThrow(InvalidTopikContentError);
    expect(renderCallout).not.toHaveBeenCalled();
  });

  it("preserves rich SSR, highlighted text and clipboard content as the same raw code", async () => {
    const element = (
      <RichTopikContentProvider>
        <TopikContent content={source} config={{ variables: { name: value } }} />
      </RichTopikContentProvider>
    );
    const serverHtml = renderToStaticMarkup(element);
    expect(parseHtml(serverHtml).querySelector("pre code")?.textContent).toBe(code);
    expect(parseHtml(serverHtml).querySelector("b")).toBeNull();

    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const dom = mount(element);
    await waitFor(() => {
      expect(dom.querySelector("pre.shiki code")?.textContent).toBe(code);
    });
    expect(dom.querySelector("b")).toBeNull();
    expect(dom.querySelector(".topik-callout__title")?.textContent).toBe(`Install ${value}`);

    const copy = dom.querySelector<HTMLButtonElement>(".topik-rich-code-block__copy");
    expect(copy).not.toBeNull();
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(code);
  });

  it("refuses interpreted code templates before the rich renderer can dispatch them", () => {
    const diagramSource =
      "{% template code %}\n```mermaid\n{% $diagram %}\n```\n{% /template code %}";
    expect(
      compileTopikContent(diagramSource, { config: { variables: { diagram: "graph TD; A-->B" } } }),
    ).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ id: "topik-code-template-language" })],
    });
    expect(() =>
      renderTopikMarkdown(diagramSource, { config: { variables: { diagram: "graph TD; A-->B" } } }),
    ).toThrow(InvalidTopikContentError);
  });
});

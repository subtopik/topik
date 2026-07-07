// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getRichTopikComponents,
  RichTopikCodeBlock,
  RichTopikContentProvider,
  richTopikComponents,
} from "./rich";
import { TopikContent } from "./theme/TopikContent";

const codeToHtmlMock = vi.hoisted(() =>
  vi.fn(
    async (_code: string, options: { lang: string; theme: string }) =>
      `<pre data-shiki-lang="${options.lang}" data-shiki-theme="${options.theme}"><code>highlighted</code></pre>`,
  ),
);
const renderToStringMock = vi.hoisted(() =>
  vi.fn(
    (content: string, options?: { displayMode?: boolean }) =>
      `<span data-katex-display="${String(options?.displayMode)}">${content}</span>`,
  ),
);
const mermaidInitializeMock = vi.hoisted(() => vi.fn());
const mermaidRenderMock = vi.hoisted(() =>
  vi.fn(async () => ({ svg: '<svg data-mermaid-rendered="true"></svg>' })),
);

vi.mock("shiki", () => ({ codeToHtml: codeToHtmlMock }));
vi.mock("katex", () => ({ renderToString: renderToStringMock }));
vi.mock("mermaid", () => ({
  default: {
    initialize: mermaidInitializeMock,
    render: mermaidRenderMock,
  },
}));

const richContent = `\`\`\`ts
const answer = 42;
\`\`\`

{% math content="E = mc^2" /%}

\`\`\`mermaid
graph TD;
  A-->B;
\`\`\``;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  codeToHtmlMock.mockClear();
  renderToStringMock.mockClear();
  mermaidInitializeMock.mockClear();
  mermaidRenderMock.mockClear();
});

afterEach(() => {
  if (!root) return;
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(element: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
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

describe("rich content-react entry", () => {
  it("exposes rich renderer overrides on top of the default component map", () => {
    const components = getRichTopikComponents();

    expect(components.TopikCodeBlock).toBe(RichTopikCodeBlock);
    expect(components.TopikMath).toBe(richTopikComponents.TopikMath);
    expect(components.TopikLink).toBeDefined();
  });

  it("server-renders through the rich provider with fallback markup", () => {
    const html = renderToStaticMarkup(
      <RichTopikContentProvider>
        <TopikContent content={richContent} />
      </RichTopikContentProvider>,
    );

    expect(html).toContain("topik-rich-code-block");
    expect(html).toContain("topik-code-block");
    expect(html).toContain("topik-math");
    expect(html).toContain("topik-mermaid");
  });

  it("renders rich client output after dynamic imports resolve", async () => {
    const dom = mount(
      <RichTopikContentProvider theme="dark">
        <TopikContent content={richContent} />
      </RichTopikContentProvider>,
    );

    await waitFor(() => {
      expect(
        dom.querySelector('.topik-rich-code-block [data-shiki-theme="github-dark"]'),
      ).not.toBeNull();
      expect(dom.querySelector('.topik-rich-math [data-katex-display="true"]')).not.toBeNull();
      expect(
        dom.querySelector('.topik-rich-mermaid [data-mermaid-rendered="true"]'),
      ).not.toBeNull();
    });

    expect(codeToHtmlMock).toHaveBeenCalledWith(expect.stringContaining("const answer = 42"), {
      lang: "ts",
      theme: "github-dark",
    });
    expect(renderToStringMock).toHaveBeenCalledWith("E = mc^2", {
      displayMode: true,
      throwOnError: false,
    });
    expect(mermaidInitializeMock).toHaveBeenCalledWith({
      securityLevel: "strict",
      startOnLoad: false,
      theme: "dark",
    });
    expect(mermaidRenderMock).toHaveBeenCalledWith(
      expect.stringMatching(/^topik-mermaid-/),
      expect.stringContaining("graph TD"),
    );
  });
});

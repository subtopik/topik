// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getRichTopikComponents,
  RichTopikCodeBlock,
  RichTopikMermaid,
  RichTopikContentProvider,
  richTopikComponents,
} from "./rich";
import { TopikContent } from "./theme/TopikContent";

const codeToTokensMock = vi.hoisted(() =>
  vi.fn(async (code: string, _options: { lang: string; theme: string }) => ({
    tokens: code.split("\n").map((content) => [{ content, color: "#24292e" }]),
    fg: "#24292e",
    bg: "#ffffff",
  })),
);
const renderToStringMock = vi.hoisted(() =>
  vi.fn(
    (content: string, options?: { displayMode?: boolean }) =>
      `<span data-katex-display="${String(options?.displayMode)}">${content}</span>`,
  ),
);
const mermaidRenderMock = vi.hoisted(() =>
  vi.fn(() => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" data-mermaid-rendered="true"></svg>',
  })),
);

vi.mock("shiki", () => ({ codeToTokens: codeToTokensMock }));
vi.mock("katex", () => ({ renderToString: renderToStringMock }));
vi.mock("pele", () => ({ render: mermaidRenderMock }));

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
  codeToTokensMock.mockClear();
  renderToStringMock.mockClear();
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

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
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

  it("server-renders through the rich provider without exposing Mermaid source", () => {
    const html = renderToStaticMarkup(
      <RichTopikContentProvider>
        <TopikContent content={richContent} />
      </RichTopikContentProvider>,
    );

    expect(html).toContain("topik-rich-code-block");
    expect(html).toContain("topik-code-block");
    expect(html).toContain("topik-math");
    expect(html).toContain("topik-rich-mermaid--loading");
    expect(html).not.toContain("graph TD");
  });

  it("shows a placeholder instead of Mermaid source while rendering", async () => {
    const dom = mount(
      <RichTopikContentProvider>
        <TopikContent content={richContent} />
      </RichTopikContentProvider>,
    );

    expect(dom.querySelector(".topik-rich-mermaid--loading")).not.toBeNull();
    expect(dom.querySelector("pre.topik-mermaid")).toBeNull();

    await waitFor(() => {
      expect(
        dom.querySelector('.topik-rich-mermaid [data-mermaid-rendered="true"]'),
      ).not.toBeNull();
    });
  });

  it("keeps the Mermaid placeholder visible for at least 300ms", async () => {
    vi.useFakeTimers();

    try {
      const dom = mount(
        <RichTopikContentProvider>
          <TopikContent content={richContent} />
        </RichTopikContentProvider>,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });

      expect(dom.querySelector(".topik-rich-mermaid--loading")).not.toBeNull();
      expect(dom.querySelector('.topik-rich-mermaid [data-mermaid-rendered="true"]')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(dom.querySelector(".topik-rich-mermaid--loading")).toBeNull();
      expect(
        dom.querySelector('.topik-rich-mermaid [data-mermaid-rendered="true"]'),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows Mermaid source when rendering fails", async () => {
    mermaidRenderMock.mockImplementationOnce(() => {
      throw new Error("Invalid diagram");
    });

    const dom = mount(
      <RichTopikContentProvider>
        <TopikContent content={richContent} />
      </RichTopikContentProvider>,
    );

    await waitFor(() => {
      expect(dom.querySelector("pre.topik-mermaid")?.textContent).toContain("graph TD");
    });
  });

  it("renders rich client output after dynamic imports resolve", async () => {
    const dom = mount(
      <RichTopikContentProvider theme="dark">
        <TopikContent content={richContent} />
      </RichTopikContentProvider>,
    );

    await waitFor(() => {
      expect(dom.querySelector(".topik-rich-code-block pre.shiki")).not.toBeNull();
      expect(dom.querySelector('.topik-rich-math [data-katex-display="true"]')).not.toBeNull();
      expect(
        dom.querySelector('.topik-rich-mermaid [data-mermaid-rendered="true"]'),
      ).not.toBeNull();
    });

    expect(codeToTokensMock).toHaveBeenCalledWith("const answer = 42;", {
      lang: "ts",
      theme: "github-dark",
    });
    expect(renderToStringMock).toHaveBeenCalledWith("E = mc^2", {
      displayMode: true,
      throwOnError: false,
    });
    expect(mermaidRenderMock).toHaveBeenCalledWith(
      expect.stringContaining("graph TD"),
      expect.objectContaining({
        idPrefix: expect.stringMatching(/^topik-mermaid-/),
        links: false,
        images: false,
      }),
    );
  });

  it("keeps simultaneous themes independent and recovers from a failed diagram", async () => {
    mermaidRenderMock.mockImplementationOnce(() => {
      throw new Error("Bad diagram");
    });
    const diagram = (theme: "light" | "dark", key: number) => (
      <RichTopikContentProvider theme={theme} key={key}>
        <TopikContent content={richContent} />
      </RichTopikContentProvider>
    );
    const dom = mount(
      <>
        {diagram("light", 0)}
        {diagram("light", 1)}
        {diagram("dark", 2)}
      </>,
    );
    await waitFor(() => {
      expect(dom.querySelectorAll("pre.topik-mermaid")).toHaveLength(1);
      expect(dom.querySelectorAll(".topik-rich-mermaid svg")).toHaveLength(2);
    });
    expect(dom.querySelector('[data-theme="light"] svg')).not.toBeNull();
    expect(dom.querySelector('[data-theme="dark"] svg')).not.toBeNull();
  });

  it("preserves the rendered diagram across theme changes without rendering again", async () => {
    vi.useFakeTimers();

    try {
      const diagram = (theme: "light" | "dark") => (
        <RichTopikContentProvider theme={theme}>
          <RichTopikMermaid content="flowchart LR; A-->B" />
        </RichTopikContentProvider>
      );
      const dom = mount(diagram("light"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      const svg = dom.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(mermaidRenderMock).toHaveBeenCalledTimes(1);

      for (const theme of ["dark", "light"] as const) {
        act(() => root?.render(diagram(theme)));

        expect(dom.querySelector(".topik-rich-mermaid")?.getAttribute("data-theme")).toBe(theme);
        expect(dom.querySelector(".topik-rich-mermaid--loading")).toBeNull();
        expect(dom.querySelector("svg")).toBe(svg);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(300);
        });

        expect(dom.querySelector(".topik-rich-mermaid--loading")).toBeNull();
        expect(dom.querySelector("svg")).toBe(svg);
        expect(mermaidRenderMock).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the rendered diagram when its source changes", async () => {
    vi.useFakeTimers();
    mermaidRenderMock
      .mockReturnValueOnce({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>First diagram</text></svg>',
      })
      .mockReturnValueOnce({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Updated diagram</text></svg>',
      });

    try {
      const dom = mount(<RichTopikMermaid content="flowchart LR; A-->B" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(dom.querySelector("svg")?.textContent).toBe("First diagram");
      expect(mermaidRenderMock).toHaveBeenCalledTimes(1);

      act(() => root?.render(<RichTopikMermaid content="flowchart LR; B-->C" />));
      expect(dom.querySelector(".topik-rich-mermaid--loading")).not.toBeNull();
      expect(dom.querySelector("svg")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(dom.querySelector(".topik-rich-mermaid--loading")).not.toBeNull();
      expect(dom.querySelector("svg")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(dom.querySelector(".topik-rich-mermaid--loading")).toBeNull();
      expect(dom.querySelector("svg")?.textContent).toBe("Updated diagram");
      expect(mermaidRenderMock).toHaveBeenCalledTimes(2);
      expect(mermaidRenderMock).toHaveBeenLastCalledWith("flowchart LR; B-->C", expect.any(Object));
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a pending result after source changes", async () => {
    const dom = mount(<RichTopikMermaid content="flowchart LR; A-->B" />);
    await waitFor(() => expect(mermaidRenderMock).toHaveBeenCalled());
    mermaidRenderMock.mockImplementationOnce(() => {
      throw new Error("Invalid new source");
    });
    act(() => root?.render(<RichTopikMermaid content="invalid new source" />));
    await waitFor(() => expect(dom.querySelector("pre")?.textContent).toBe("invalid new source"));
    expect(dom.querySelector("svg")).toBeNull();
  });

  it("discards pending results on unmount", async () => {
    const dom = mount(<RichTopikMermaid content="flowchart LR; A-->B" />);
    await waitFor(() => expect(mermaidRenderMock).toHaveBeenCalled());
    act(() => root?.unmount());
    root = undefined;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(dom.innerHTML).toBe("");
    dom.remove();
  });

  it("hydrates the server placeholder without mismatches", async () => {
    const element = <RichTopikMermaid content="flowchart LR; A-->B" />;
    const errors: unknown[] = [];
    container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(element);
    document.body.append(container);
    act(() => {
      root = hydrateRoot(container!, element, {
        onRecoverableError: (error) => errors.push(error),
      });
    });
    await waitFor(() => expect(container?.querySelector("svg")).not.toBeNull());
    expect(errors).toEqual([]);
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "pele";
import { withDiagramMath } from "./diagram-math";
import { safeDiagramSvg } from "./diagram-svg";

const loaded = vi.hoisted(() => vi.fn());
const typeset = vi.hoisted(() => vi.fn<typeof import("katex").renderToString>());
vi.mock("katex", () => {
  loaded();
  return { renderToString: typeset };
});

const math =
  '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mfrac><mi>x</mi><mi>y</mi></mfrac></math>';
const markup = `<span class="katex">${math}</span>`;
const fonts = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  typeset.mockReset().mockReturnValue(markup);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 60,
    height: 45,
    x: 0,
    y: 0,
    top: 0,
    right: 60,
    bottom: 45,
    left: 0,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  if (fonts) Object.defineProperty(document, "fonts", fonts);
  else Reflect.deleteProperty(document, "fonts");
  expect(document.querySelector('.topik-rich-mermaid[aria-hidden="true"]')).toBeNull();
});

describe("diagram math resolver", () => {
  it("keeps ordinary diagrams from loading KaTeX", async () => {
    await withDiagramMath("flowchart LR; A-->B", (resolver) => expect(resolver).toBeUndefined());
    expect(loaded).not.toHaveBeenCalled();
  });

  it("returns measured MathML at each requested font size with safe KaTeX options", async () => {
    await withDiagramMath("$$x$$", (resolver) => {
      expect(resolver?.("x", 16)).toEqual({ html: math, width: 60, height: 45 });
      expect(resolver?.("x", 14)).toEqual({ html: math, width: 60, height: 45 });
      expect(
        document.querySelector('.topik-rich-mermaid[aria-hidden="true"]')?.children,
      ).toHaveLength(0);
    });
    expect(typeset).toHaveBeenCalledWith("x", {
      displayMode: true,
      output: "mathml",
      throwOnError: true,
      trust: false,
      strict: "error",
      maxExpand: 1000,
      maxSize: 10,
      macros: {},
    });
    expect(typeset.mock.calls[0][1]!.macros).not.toBe(typeset.mock.calls[1][1]!.macros);
  });

  it("waits for pending fonts without adding a probe to the page", async () => {
    let ready!: () => void;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        ready: new Promise<void>((resolve) => {
          ready = resolve;
        }),
      },
    });
    const draw = vi.fn();
    const pending = withDiagramMath("$$x$$", draw);
    await Promise.resolve();
    expect(draw).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
    ready();
    await pending;
    expect(draw).toHaveBeenCalledOnce();
  });

  it("continues after one second if unrelated fonts never settle", async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { ready: new Promise<void>(() => {}) },
      });
      const draw = vi.fn();
      const pending = withDiagramMath("$$x$$", draw);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      expect(draw).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a diagram when one formula is invalid", async () => {
    typeset.mockImplementation((tex: string) => {
      if (tex === "bad") throw new Error("Invalid formula");
      return markup;
    });
    const source = 'flowchart LR\n A["$$good$$ and $$bad$$"] --> B';
    const svg = await withDiagramMath(source, (resolver) =>
      safeDiagramSvg(render(source, { math: resolver, links: false, images: false }).svg),
    );
    expect(svg).toContain("<math");
    expect(svg).toContain("$$bad$$");
    expect(svg).not.toContain("$$good$$");
  });

  it.each([0, NaN, Infinity, 4097])(
    "keeps TeX when measurement is unusable (%s)",
    async (width) => {
      vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({
        width,
        height: 40,
      } as DOMRect);
      await withDiagramMath("$$x$$", (resolver) => expect(resolver?.("x", 16)).toBeNull());
    },
  );

  it("rejects unsafe typesetter output before measuring it", async () => {
    typeset.mockReturnValue(
      '<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"><mtext href="https://example.com">x</mtext></math></span>',
    );
    await withDiagramMath("$$x$$", (resolver) => expect(resolver?.("x", 16)).toBeNull());
    expect(Element.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("bounds formula input, dimensions and total resolver calls", async () => {
    await withDiagramMath("$$x$$", (resolver) => {
      expect(resolver?.("x".repeat(4097), 16)).toBeNull();
      expect(resolver?.("x", Infinity)).toBeNull();
      expect(resolver?.("x", 257)).toBeNull();
      for (let index = 0; index < 97; index++) expect(resolver?.("x", 16)).not.toBeNull();
      expect(resolver?.("x", 16)).toBeNull();
    });
    expect(typeset).toHaveBeenCalledTimes(97);
  });

  it("bounds aggregate MathML output and resets budgets for the next diagram", async () => {
    const large = `<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"><mtext>${"x".repeat(95_000)}</mtext></math></span>`;
    typeset.mockReturnValue(large);
    await withDiagramMath("$$x$$", (resolver) => {
      for (let index = 0; index < 10; index++) expect(resolver?.("x", 16)).not.toBeNull();
      expect(resolver?.("x", 16)).toBeNull();
      expect(resolver?.("x", 16)).toBeNull();
    });
    await withDiagramMath("$$x$$", (resolver) => expect(resolver?.("x", 16)).not.toBeNull());
    expect(typeset).toHaveBeenCalledTimes(12);
  });

  it("removes the probe even when diagram rendering throws", async () => {
    await expect(
      withDiagramMath("$$x$$", (resolver) => {
        resolver?.("x", 16);
        throw new Error("Invalid diagram");
      }),
    ).rejects.toThrow("Invalid diagram");
  });
});

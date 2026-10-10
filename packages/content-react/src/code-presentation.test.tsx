// @vitest-environment jsdom

import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RichTopikCodeBlock } from "./rich/components";
import { TopikCodeBlock, TopikCodeGroup, TopikCodeTab } from "./theme/components";
import { TopikContent } from "./theme/TopikContent";
import type { TopikComponentProps } from "./core/components";
import type { CodeHighlight } from "./theme/code-block";
import { CODE_PRESENTATION_LIMITS, type CodePresentationEffectiveOptions } from "@topik/content";

const codeToTokens = vi.hoisted(() =>
  vi.fn(
    async (payload: string, _options: { lang: string; theme: string }): Promise<CodeHighlight> => ({
      tokens: payload.split("\n").map((content) => [{ content, color: "#24292e" }]),
      bg: "#ffffff",
      fg: "#24292e",
    }),
  ),
);
vi.mock("shiki", () => ({ codeToTokens }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  codeToTokens.mockClear();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function mount(element: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

function button(dom: HTMLElement, label: string): HTMLButtonElement {
  const found = [...dom.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

const options = {
  title: "Update client",
  filename: "client.ts",
  lineNumbers: true,
  startLine: 90,
  wrap: false,
  highlight: [[2, 2]],
  focus: [[2, 2]],
  added: [[1, 1]],
  removed: [[2, 2]],
  collapseAfter: 1,
} satisfies CodePresentationEffectiveOptions;

describe.each([
  ["plain", TopikCodeBlock],
  ["rich", RichTopikCodeBlock],
] satisfies [string, ComponentType<TopikComponentProps>][])("%s presented code", (_name, Code) => {
  it("renders compact fence attributes with full SSR text and canonical hydrated copy", async () => {
    const payload = "+authored addition  \n\t−authored removal\n";
    const source = [
      '```ts filename="client.ts" title="Update client" lines startLine=90 highlight="2" focus="2" collapseAfter=1 wrap=false added="1" removed="2"',
      payload,
      "```",
    ].join("\n");
    const element = <TopikContent content={source} components={{ TopikCodeBlock: Code }} />;
    container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    expect(container.querySelectorAll("[data-line]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-line][hidden]")).toHaveLength(0);
    expect(
      [...container.querySelectorAll(".topik-code-block__text")]
        .map((row) => row.textContent)
        .join(""),
    ).toBe(`${payload}\n`);
    expect(container.querySelector(".topik-code-block__line-number")?.textContent).toBe("90");
    expect(container.querySelector(".topik-code-block__title")?.textContent).toBe("Update client");

    const recoverableError = vi.fn();
    await act(async () => {
      root = hydrateRoot(container!, element, { onRecoverableError: recoverableError });
    });
    expect(recoverableError).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-line][hidden]")).toHaveLength(2);
    await act(async () => button(container!, "Copy").click());
    expect(writeText).toHaveBeenCalledWith(`${payload}\n`);
  });

  it("keeps all rows readable before hydration and collapses only with working controls", async () => {
    const payload = "+authored addition\n−authored removal\n";
    const element = (
      <Code payload={payload} content={`${payload}\n`} language="ts" presentation={options} />
    );
    container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    expect(container.querySelectorAll("[data-line]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-line][hidden]")).toHaveLength(0);
    expect(button(container, "Show fewer lines").disabled).toBe(true);
    expect(button(container, "Show fewer lines").getAttribute("aria-expanded")).toBe("true");

    const recoverableError = vi.fn();
    await act(async () => {
      root = hydrateRoot(container!, element, { onRecoverableError: recoverableError });
    });

    expect(recoverableError).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-line][hidden]")).toHaveLength(2);
    const expand = button(container, "Show all 3 lines");
    expect(expand.disabled).toBe(false);
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(expand.getAttribute("aria-controls")!)).toBe(
      container.querySelector("pre"),
    );
    expand.focus();
    act(() => expand.click());
    expect(document.activeElement).toBe(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll("[data-line][hidden]")).toHaveLength(0);
  });

  it("copies full canonical text across collapse, wrapping, focus and diff state", async () => {
    const payload = "+authored addition  \n\t−authored removal\n";
    const dom = await mount(
      <Code payload={payload} content={`${payload}\n`} language="ts" presentation={options} />,
    );
    expect(dom.querySelectorAll(".topik-code-block__line-number")[0].textContent).toBe("90");
    expect(dom.querySelector('[data-line="2"]')?.getAttribute("data-highlighted")).toBe("true");
    expect(dom.querySelector('[data-line="1"]')?.getAttribute("data-focused")).toBe("false");
    expect(dom.querySelector('[data-line="2"]')?.getAttribute("data-diff")).toBe("removed");
    expect(dom.querySelector(".topik-code-block__legend")?.textContent).toContain("+ Added line");
    expect(dom.querySelector('[data-line="2"] .topik-code-block__sr-only')?.textContent).toBe(
      "Removed line: ",
    );
    expect(dom.querySelector(".topik-code-block__title")?.textContent).toBe("Update client");
    expect(dom.querySelector(".topik-code-block__filename")?.textContent).toBe("client.ts");
    expect(dom.querySelector(".topik-code-block__language")?.textContent).toBe("ts");

    const wrap = button(dom, "Wrap lines");
    wrap.focus();
    act(() => wrap.click());
    expect(document.activeElement).toBe(wrap);
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button(dom, "Copy").click());
    expect(writeText).toHaveBeenLastCalledWith(`${payload}\n`);
    act(() => button(dom, "Show all 3 lines").click());
    await act(async () => button(dom, "Copied").click());
    expect(writeText).toHaveBeenLastCalledWith(`${payload}\n`);
  });

  it.each(["", "\t a  ", "\n", "a\n", "a\n\n", "<script>&amp;\"'\\"])(
    "preserves payload %j including physical blank rows and escaping",
    async (payload) => {
      const dom = await mount(
        <Code
          payload={payload}
          content={`${payload}\n`}
          presentation={{ lineNumbers: false, wrap: false }}
        />,
      );
      const rows = dom.querySelectorAll("[data-line]");
      expect(rows).toHaveLength(payload.split("\n").length);
      expect(
        [...rows].map((row) => row.querySelector(".topik-code-block__text")?.textContent),
      ).toEqual(payload.split("\n").map((row) => `${row}\n`));
      expect(dom.querySelector("script")).toBeNull();
      await act(async () => button(dom, "Copy").click());
      expect(writeText).toHaveBeenCalledWith(`${payload}\n`);
    },
  );
});

describe.each([
  ["plain", TopikCodeBlock],
  ["rich", RichTopikCodeBlock],
] satisfies [string, ComponentType<TopikComponentProps>][])("%s ordinary code", (_name, Code) => {
  it("server-renders large ordinary fences without allocating physical row elements", () => {
    const payload = "\n".repeat(99_999);
    const html = renderToString(
      <Code payload={payload} content={`${payload}\n`} language="text" />,
    );
    expect(html).not.toContain("data-line=");
    expect(html.length).toBeLessThan(payload.length + 4096);
    expect(html).toContain(`<code>${payload}\n</code>`);
  });

  it("keeps large ordinary fences readable and copyable without loading highlighting", async () => {
    const payload = "\n".repeat(CODE_PRESENTATION_LIMITS.rows);
    const dom = await mount(<Code payload={payload} content={`${payload}\n`} language="text" />);
    expect(dom.querySelectorAll("[data-line]")).toHaveLength(0);
    expect(dom.querySelector("pre code")?.textContent).toBe(`${payload}\n`);
    expect(codeToTokens).not.toHaveBeenCalled();
    await act(async () => button(dom, "Copy").click());
    expect(writeText).toHaveBeenCalledWith(`${payload}\n`);
  });
});

describe("highlighting and groups", () => {
  it.each([
    "const values = [1, 2, 3, 4, 5, 6];",
    "const { data, error } = await supabase.from('countries').select('id, name');",
    Array.from({ length: 100 }, (_, index) => `const values${index} = [1, 2, 3, 4, 5, 6];`).join(
      "\n",
    ),
    [
      "const users = [",
      ...Array.from(
        { length: 100 },
        (_, id) => `  { id: ${id}, name: 'User ${id}', active: true, region: 'Europe' },`,
      ),
      "];",
    ].join("\n"),
  ])("keeps real Shiki highlighting for ordinary and presented snippet %j", async (payload) => {
    const shiki = await vi.importActual<typeof import("shiki")>("shiki");
    const highlight = await shiki.codeToTokens(payload, { lang: "ts", theme: "github-light" });
    for (const presentation of [undefined, { lineNumbers: false, wrap: false }]) {
      codeToTokens.mockImplementationOnce(async () => highlight);
      const dom = await mount(
        <RichTopikCodeBlock
          payload={payload}
          content={`${payload}\n`}
          language="ts"
          presentation={presentation}
        />,
      );
      expect(dom.querySelector("pre.shiki")).not.toBeNull();
      expect(dom.querySelectorAll("pre code span[style]").length).toBeGreaterThan(6);
      expect(dom.querySelector("pre code")?.textContent).toBe(`${payload}\n`);
      act(() => root?.unmount());
      dom.remove();
      root = undefined;
      container = undefined;
    }
  });

  it("elides default-color spans even when Shiki uses different hex casing", async () => {
    codeToTokens.mockImplementationOnce(async (payload) => ({
      tokens: [
        Array.from({ length: 100 }, () => ({ content: "", color: "#24292E" })).concat({
          content: payload,
          color: "#D73A49",
        }),
      ],
      fg: "#24292e",
      bg: "#ffffff",
    }));
    const dom = await mount(<RichTopikCodeBlock payload="const" content={"const\n"} />);
    expect(dom.querySelector("pre.shiki")).not.toBeNull();
    expect(dom.querySelectorAll("pre code span")).toHaveLength(1);
  });

  it("highlights payload rather than the synthetic separator and renders trusted text once", async () => {
    const payload = "<b>&amp;\n";
    const dom = await mount(
      <RichTopikCodeBlock
        payload={payload}
        content={`${payload}\n`}
        language="ts"
        presentation={{ lineNumbers: false, wrap: false }}
      />,
    );
    expect(codeToTokens).toHaveBeenCalledWith(payload, { lang: "ts", theme: "github-light" });
    expect(dom.querySelector("pre.shiki")).not.toBeNull();
    expect(dom.querySelectorAll("[data-line]")).toHaveLength(2);
    expect(dom.querySelector("b")).toBeNull();
    expect(dom.querySelector(".topik-code-block__text")?.textContent).toBe("<b>&amp;\n");
  });

  it("falls back with the same options and copy content when the language cannot load", async () => {
    codeToTokens.mockRejectedValueOnce(new Error("Unknown language"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = "first\nsecond\n";
    const dom = await mount(
      <RichTopikCodeBlock
        payload={payload}
        content={`${payload}\n`}
        language="unknown-language"
        presentation={options}
      />,
    );
    expect(dom.querySelector("pre.shiki")).toBeNull();
    expect(dom.querySelectorAll("[data-line]")).toHaveLength(3);
    expect(dom.querySelectorAll("[data-line][hidden]")).toHaveLength(2);
    expect(dom.querySelector(".topik-code-block__filename")?.textContent).toBe("client.ts");
    await act(async () => button(dom, "Copy").click());
    expect(writeText).toHaveBeenCalledWith(`${payload}\n`);
  });

  it.each(["rows", "text", "budget"])(
    "refuses highlighter %s changes before decorating",
    async (failure) => {
      codeToTokens.mockImplementationOnce(async (payload) => ({
        tokens:
          failure === "rows"
            ? [[{ content: payload }], [{ content: "" }]]
            : failure === "text"
              ? [[{ content: "altered" }]]
              : [
                  Array.from({ length: 100 }, () => ({ content: "", color: "#123456" })).concat({
                    content: payload,
                    color: "#123456",
                  }),
                ],
        fg: "#24292e",
        bg: "#ffffff",
      }));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const dom = await mount(<RichTopikCodeBlock payload="source" content={"source\n"} />);
      expect(dom.querySelector("pre.shiki")).toBeNull();
      expect(dom.querySelector("pre code")?.textContent).toBe("source\n");
    },
  );

  it("keeps multiple fences in a tab independent and targets copy in the active panel", async () => {
    const dom = await mount(
      <TopikCodeGroup>
        <TopikCodeTab title="First">
          <RichTopikCodeBlock payload="one" content={"one\n"} />
          <RichTopikCodeBlock payload="two" content={"two\n"} />
        </TopikCodeTab>
        <TopikCodeTab title="Second">
          <RichTopikCodeBlock payload="three" content={"three\n"} />
        </TopikCodeTab>
      </TopikCodeGroup>,
    );
    expect(
      dom.querySelectorAll('[role="tabpanel"]')[0].querySelectorAll(".topik-code-block"),
    ).toHaveLength(2);
    act(() => {
      dom
        .querySelectorAll<HTMLButtonElement>('[role="tab"]')[0]
        .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });
    const panel = dom.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
    await act(async () => button(panel, "Copy").click());
    expect(writeText).toHaveBeenCalledWith("three\n");
  });
});

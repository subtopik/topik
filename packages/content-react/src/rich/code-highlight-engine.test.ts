// @vitest-environment node
import { expect, it, vi } from "vite-plus/test";
import { highlightCode } from "./code-highlight";

const loaded = vi.hoisted(() => [] as string[]);
const unsupported = vi.hoisted(() => ({ grammar: false }));

vi.mock("shiki/wasm", () => {
  loaded.push("shiki/wasm");
  return { default: {} };
});
vi.mock("shiki/engine/oniguruma", () => {
  loaded.push("shiki/engine/oniguruma");
  return {};
});
vi.mock("shiki/engine/javascript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("shiki/engine/javascript")>();
  return {
    ...actual,
    createJavaScriptRegexEngine: (
      ...args: Parameters<typeof actual.createJavaScriptRegexEngine>
    ) => {
      const engine = actual.createJavaScriptRegexEngine(...args);
      return {
        ...engine,
        createScanner(patterns: Parameters<typeof engine.createScanner>[0]) {
          // Simulates a grammar pattern the JavaScript engine cannot translate.
          if (unsupported.grammar) throw new Error("Unsupported grammar pattern");
          return engine.createScanner(patterns);
        },
      };
    },
  };
});

it("never loads the WebAssembly engine when the JavaScript engine is selected", async () => {
  const highlight = await highlightCode("const a = 1;", {
    lang: "ts",
    theme: "github-dark",
    engine: "javascript",
  });
  expect(highlight.tokens[0].map((token) => token.content).join("")).toBe("const a = 1;");
  expect(highlight.tokens[0].some((token) => token.color !== highlight.fg)).toBe(true);

  unsupported.grammar = true;
  await expect(
    highlightCode("fn main() {}", { lang: "rust", theme: "github-light", engine: "javascript" }),
  ).rejects.toThrow("Unsupported grammar pattern");
  expect(loaded).toEqual([]);
});

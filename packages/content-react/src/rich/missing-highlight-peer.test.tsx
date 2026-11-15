// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { RichTopikCodeBlock, RichTopikThemeProvider } from "./components";
vi.mock("shiki/core", () => {
  throw new Error("Optional peer not installed");
});
it.each(["oniguruma", "javascript"] as const)(
  "shows plain code when Shiki is not installed (%s engine)",
  async (engine) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <RichTopikThemeProvider codeHighlightEngine={engine}>
            <RichTopikCodeBlock payload="const a = 1;" language="ts" />
          </RichTopikThemeProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(warn).toHaveBeenCalledWith("Failed to highlight code; using plain code");
      expect(container.querySelector("pre.shiki")).toBeNull();
      expect(container.querySelector("pre code")?.textContent).toBe("const a = 1;\n");
    } finally {
      act(() => root.unmount());
    }
  },
);

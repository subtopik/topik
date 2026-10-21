// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { RichTopikMermaid } from "./components";
vi.mock("pele", () => {
  throw new Error("Optional peer not installed");
});
it("shows source when the optional renderer cannot load", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<RichTopikMermaid content="flowchart LR; A-->B" />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(container.querySelector("pre")?.textContent).toBe("flowchart LR; A-->B");
  } finally {
    act(() => root.unmount());
  }
});

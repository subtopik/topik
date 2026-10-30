// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { RichTopikMermaid } from "./components";

vi.mock("katex", () => {
  throw new Error("Optional peer not installed");
});

it("keeps the diagram and escaped TeX when optional KaTeX cannot load", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<RichTopikMermaid content={'flowchart LR\n A["$$x^2$$"] --> B'} />);
    });
    await vi.waitFor(
      async () => {
        await act(async () => {});
        expect(container.querySelector("svg")).not.toBeNull();
      },
      { timeout: 3000 },
    );
    expect(container.querySelector("svg")?.textContent).toContain("$$x^2$$");
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("foreignObject")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

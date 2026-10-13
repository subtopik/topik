// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { TopikContent } from "../theme/TopikContent";
import { createPreviewAssetAdapter, type PreviewAssetAdapter } from "./preview-assets";
const name = `auto-v1-${"a".repeat(52)}`;
const bytes = new Uint8Array([1, 2, 3]);
const digest = createHash("sha256").update(bytes).digest("hex");
let root: Root;
let adapter: PreviewAssetAdapter;
let container: HTMLDivElement;
function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:managed";
      }
      static revokeObjectURL() {}
    },
  );
  adapter = createPreviewAssetAdapter({
    origin: "http://localhost:50001",
    snapshot: {
      sessionId: "one",
      generation: 1,
      resources: [
        {
          type: "Asset",
          name,
          spec: {
            uri: `blobs/${digest}`,
            integrity: `sha256:${digest}`,
            size: 3,
            mediaType: "image/png",
          },
        },
      ],
      payloads: [
        {
          path: `blobs/${digest}`,
          integrity: `sha256:${digest}`,
          size: 3,
          mediaType: "image/png",
          assetNames: [name],
        },
      ],
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}
afterEach(async () => {
  await act(async () => root?.unmount());
  adapter?.dispose();
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("failed media has an accessible explanation while text remains readable", async () => {
  setup();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private network error")));
  await act(async () =>
    root.render(
      <TopikContent content={`Text survives.\n\n![Hero](asset:${name})`} previewAssets={adapter} />,
    ),
  );
  expect(container.textContent).toContain("Text survives.");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Preview media unavailable.",
  );
  expect(container.textContent).not.toContain("private network error");
});

test("a delayed download cannot activate after the rendered content changes", async () => {
  setup();
  let finish!: (value: unknown) => void;
  let requested!: URL;
  vi.stubGlobal("fetch", (url: URL) => {
    requested = url;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await act(async () =>
    root.render(<TopikContent content={`[Download](asset:${name})`} previewAssets={adapter} />),
  );
  expect(container.querySelector("a")).toBeNull();
  await act(async () => container.querySelector("button")!.click());
  await act(async () =>
    root.render(<TopikContent content={`[Changed page](asset:${name})`} previewAssets={adapter} />),
  );
  await act(async () => {
    finish({
      ok: true,
      redirected: false,
      url: requested.href,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => bytes.buffer,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(click).not.toHaveBeenCalled();
});

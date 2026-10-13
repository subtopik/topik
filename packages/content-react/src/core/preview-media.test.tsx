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
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(click).not.toHaveBeenCalled();
});

function mediaResponse(url: URL) {
  const result = new Response(bytes, { headers: { "content-type": "image/png" } });
  Object.defineProperty(result, "url", { value: url.href });
  return result;
}
async function showMedia(content: string) {
  await act(async () => root.render(<TopikContent content={content} previewAssets={adapter} />));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.querySelector("img")).not.toBeNull();
  });
}

test("revisiting failed media retries with the same generation adapter", async () => {
  setup();
  const fetcher = vi
    .fn<(url: URL) => Promise<Response>>()
    .mockRejectedValueOnce(new Error("Temporary failure"))
    .mockImplementation(async (url) => mediaResponse(url));
  vi.stubGlobal("fetch", fetcher);
  const content = `![Hero](asset:${name})`;
  await act(async () => root.render(<TopikContent content={content} previewAssets={adapter} />));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => root.render(null));
  await showMedia(content);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  await showMedia(content);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each([
  `Text survives.\n\n![Hero](asset:${name})`,
  `Text survives.\n\n{% figure src="asset:${name}" darkSrc="asset:${name}" alt="Figure" /%}`,
])("browser image errors explain failed media without retry loops: %s", async (content) => {
  setup();
  const fetcher = vi.fn(async (url: URL) => mediaResponse(url));
  vi.stubGlobal("fetch", fetcher);
  await showMedia(content);
  await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Preview media unavailable.",
  );
  expect(container.textContent).toContain("Text survives.");
  expect(container.querySelector("img")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("late image errors from retired content and disposed generations are ignored", async () => {
  setup();
  vi.stubGlobal("fetch", async (url: URL) => mediaResponse(url));
  await showMedia(`![Old](asset:${name})`);
  const retired = container.querySelector("img")!;
  await showMedia(`![Current](asset:${name})`);
  expect(container.querySelector("img")).not.toBe(retired);
  await act(async () => retired.dispatchEvent(new Event("error")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  adapter.dispose();
  await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { act, startTransition, Suspense, useEffect, useLayoutEffect, StrictMode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
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

test.each(["unchanged", "suspended", "replaced", "unmounted"] as const)(
  "a delayed download respects committed content: %s",
  async (lifecycle) => {
    setup();
    let finish!: (value: Response) => void;
    let requested!: URL;
    vi.stubGlobal("fetch", (url: URL) => {
      requested = url;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const objectUrl = vi.spyOn(URL, "createObjectURL");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const never = new Promise<void>(() => {});
    let suspended = false;
    function Block({ block }: { block: boolean }) {
      if (block) {
        suspended = true;
        throw never;
      }
      return null;
    }
    function Page({ replacement = false, block = false }) {
      return (
        <Suspense fallback="Waiting">
          <TopikContent
            content={`[${replacement ? "Changed page" : "Download"}](asset:${name})`}
            previewAssets={adapter}
          />
          <Block block={block} />
        </Suspense>
      );
    }
    await act(async () => root.render(<Page />));
    expect(container.querySelector("a")).toBeNull();
    if (lifecycle === "suspended") {
      await act(async () => {
        startTransition(() => root.render(<Page replacement block />));
      });
      expect(suspended).toBe(true);
      expect(container.querySelector("button")?.textContent).toBe("Download");
      expect(container.textContent).not.toContain("Waiting");
    }
    await act(async () => container.querySelector("button")!.click());
    if (lifecycle === "replaced") {
      await act(async () => root.render(<Page replacement />));
      expect(container.querySelector("button")?.textContent).toBe("Changed page");
    } else if (lifecycle === "unmounted") {
      await act(async () => root.render(null));
      expect(container.querySelector("button")).toBeNull();
    }
    await act(async () => {
      finish(mediaResponse(requested));
      await vi.waitFor(() => expect(objectUrl).toHaveBeenCalledTimes(1));
    });
    expect(click).toHaveBeenCalledTimes(
      lifecycle === "unchanged" || lifecycle === "suspended" ? 1 : 0,
    );
  },
);

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

test.each([false, true])(
  "suppresses downloads before passive unmount cleanup (StrictMode: %s)",
  async (strict) => {
    setup();
    vi.stubGlobal("fetch", async (url: URL) => mediaResponse(url));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const actualDigest = await crypto.subtle.digest("SHA-256", bytes);
    let finishDigest!: (value: ArrayBuffer) => void;
    const hashing = vi.spyOn(crypto.subtle, "digest").mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishDigest = resolve;
        }),
    );
    let passiveCleanup = false;
    let removed!: () => void;
    const afterRemoval = new Promise<void>((resolve) => {
      removed = resolve;
    });
    function Sentinel() {
      useEffect(() => {
        passiveCleanup = false;
        return () => {
          passiveCleanup = true;
        };
      }, []);
      return null;
    }
    function Page({ show }: { show: boolean }) {
      useLayoutEffect(() => {
        if (!show) {
          finishDigest(actualDigest);
          removed();
        }
      }, [show]);
      return show ? (
        <>
          <TopikContent content={`[Download](asset:${name})`} previewAssets={adapter} />
          <Sentinel />
        </>
      ) : (
        <p>Removed</p>
      );
    }
    const page = (show: boolean) =>
      strict ? (
        <StrictMode>
          <Page show={show} />
        </StrictMode>
      ) : (
        <Page show={show} />
      );
    await act(async () => root.render(page(true)));
    await act(async () => {
      container.querySelector("button")!.click();
      await vi.waitFor(() => expect(hashing).toHaveBeenCalledTimes(1));
    });
    // act would flush passive cleanup and hide the interval this test exercises.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    try {
      startTransition(() => root.render(page(false)));
      await afterRemoval;
      // Drain the adapter's promise chain without advancing the passive-effect task.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(container.textContent).toBe("Removed");
      expect(passiveCleanup).toBe(false);
      expect(click).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    }
  },
);

test("preview downloads hydrate and activate under StrictMode", async () => {
  setup();
  await act(async () => root.unmount());
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: URL) => mediaResponse(url));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const content = (
    <StrictMode>
      <TopikContent content={`[Download](asset:${name})`} previewAssets={adapter} />
    </StrictMode>
  );
  container.innerHTML = renderToString(content);
  expect(container.querySelector("button")?.textContent).toBe("Download");
  await act(async () => {
    root = hydrateRoot(container, content);
  });
  await act(async () => {
    container.querySelector("button")!.click();
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  });
  expect(errors).not.toHaveBeenCalled();
});

// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  createPreviewAssetAdapter,
  getPreviewAssetToken,
  previewAssetToken,
  type PreviewAssetInventory,
} from "./preview-assets";
const name = `auto-v1-${"a".repeat(52)}`;
const bytes = new Uint8Array([1, 2, 3]);
const digest = createHash("sha256").update(bytes).digest("hex");
function inventory(): PreviewAssetInventory {
  return {
    sessionId: "session-one",
    generation: 1,
    resources: [
      {
        type: "Asset",
        name,
        spec: {
          uri: `blobs/${digest}`,
          integrity: `sha256:${digest}`,
          mediaType: "image/png",
          size: 3,
        },
      },
    ],
    payloads: [
      {
        path: `blobs/${digest}`,
        integrity: `sha256:${digest}`,
        mediaType: "image/png",
        size: 3,
        assetNames: [name],
      },
    ],
  };
}
function load(
  adapter: ReturnType<typeof createPreviewAssetAdapter>,
  slot: "image.src" | "link.href" = "image.src",
) {
  const token = getPreviewAssetToken(previewAssetToken(adapter, name, slot))!;
  return token.state.load(token.name, token.slot);
}
function response(url: URL, data = bytes) {
  const result = new Response(data, { headers: { "content-type": "image/png" } });
  Object.defineProperty(result, "url", { value: url.href });
  return result;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("admits only exact loopback origins and complete matched local inventories", () => {
  for (const origin of [
    "https://localhost:50001",
    "http://evil.test",
    "http://localhost.evil.test",
    "http://127.0.0.1:50001/path",
    "http://user@localhost:50001",
    "http://localhost:50001?x=1",
    "http://localhost:50001/",
    "//localhost:50001",
  ])
    expect(() => createPreviewAssetAdapter({ origin, snapshot: inventory() })).toThrow();
  for (const uri of [
    "//evil.test/payload",
    "http://localhost:50001/blobs/a",
    `blobs/../blobs/${digest}`,
    `blobs/%2e%2e/${digest}`,
    `/blobs/${digest}`,
    `blobs/${digest}?x=1`,
  ]) {
    const snapshot = inventory();
    (snapshot.resources[0].spec as { uri: string }).uri = uri;
    expect(() =>
      createPreviewAssetAdapter({ origin: "http://localhost:50001", snapshot }),
    ).toThrow();
  }
  const incomplete = inventory();
  incomplete.payloads = [];
  expect(() =>
    createPreviewAssetAdapter({ origin: "http://localhost:50001", snapshot: incomplete }),
  ).toThrow();
  const duplicate = inventory();
  duplicate.payloads = [...duplicate.payloads, ...duplicate.payloads];
  expect(() =>
    createPreviewAssetAdapter({ origin: "http://localhost:50001", snapshot: duplicate }),
  ).toThrow();
  expect(previewAssetToken({ dispose() {} }, name, "image.src")).toBeUndefined();
});

test("fetches with origin safety, checks bytes, scopes caches and revokes capabilities", async () => {
  const fetcher = vi.fn(async (url: URL) => response(url));
  vi.stubGlobal("fetch", fetcher);
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:owned");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const snapshot = inventory();
  const adapter = createPreviewAssetAdapter({ origin: "http://localhost:50001", snapshot });
  (snapshot.resources[0].spec as { uri: string }).uri = "https://evil.test";
  await expect(load(adapter)).resolves.toBe("blob:owned");
  await load(adapter);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0].href).toBe(
    `http://localhost:50001/blobs/${digest}?sessionId=session-one&generation=1`,
  );
  expect(fetcher).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      mode: "cors",
      cache: "no-store",
    }),
  );
  expect((create.mock.calls[0][0] as Blob).type).toBe("image/png");
  await load(adapter, "link.href");
  expect((create.mock.calls[1][0] as Blob).type).toBe("application/octet-stream");
  const other = createPreviewAssetAdapter({
    origin: "http://localhost:50001",
    snapshot: { ...inventory(), sessionId: "session-two" },
  });
  await load(other);
  expect(fetcher).toHaveBeenCalledTimes(3);
  adapter.dispose();
  expect(revoke).toHaveBeenCalledWith("blob:owned");
  expect(previewAssetToken(adapter, name, "image.src")).toBeUndefined();
  other.dispose();
});

test("rejects changed bytes, wrong response origins/types and stale asynchronous results", async () => {
  const create = vi.spyOn(URL, "createObjectURL");
  for (const kind of ["bytes", "origin", "type", "redirect"]) {
    vi.stubGlobal("fetch", async (url: URL) => {
      const result = response(
        kind === "origin" ? new URL("https://evil.test") : url,
        kind === "bytes" ? new Uint8Array([3, 2, 1]) : bytes,
      );
      if (kind === "type") result.headers.set("content-type", "text/html");
      if (kind === "redirect") Object.defineProperty(result, "redirected", { value: true });
      return result;
    });
    const adapter = createPreviewAssetAdapter({
      origin: "http://localhost:50001",
      snapshot: inventory(),
    });
    await expect(load(adapter)).rejects.toThrow();
    adapter.dispose();
  }
  let finish!: (response: Response) => void;
  let requested!: URL;
  vi.stubGlobal("fetch", (url: URL) => {
    requested = url;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const adapter = createPreviewAssetAdapter({
    origin: "http://localhost:50001",
    snapshot: inventory(),
  });
  const pending = load(adapter);
  adapter.dispose();
  finish(response(requested));
  await expect(pending).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

test("active media is download-only and arbitrary names never gain authority", () => {
  const snapshot = inventory();
  (snapshot.resources[0].spec as { mediaType: string }).mediaType = "image/svg+xml";
  snapshot.payloads = [{ ...snapshot.payloads[0], mediaType: "image/svg+xml" }];
  const adapter = createPreviewAssetAdapter({ origin: "http://localhost:50001", snapshot });
  expect(previewAssetToken(adapter, name, "image.src")).toBeUndefined();
  expect(previewAssetToken(adapter, name, "link.href")).toBeDefined();
  expect(previewAssetToken(adapter, "unknown", "link.href")).toBeUndefined();
  adapter.dispose();
});

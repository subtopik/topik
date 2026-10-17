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

test("retries rejected loads while deduplicating in-flight and successful attempts", async () => {
  let reject!: (error: Error) => void;
  const fetcher = vi
    .fn<(url: URL) => Promise<Response>>()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockImplementation(async (url) => response(url));
  vi.stubGlobal("fetch", fetcher);
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retried");
  const adapter = createPreviewAssetAdapter({
    origin: "http://localhost:50001",
    snapshot: inventory(),
  });
  try {
    const first = load(adapter);
    const concurrent = load(adapter);
    expect(concurrent).toBe(first);
    const failures = Promise.allSettled([first, concurrent]);
    reject(new Error("Temporary fetch failure"));
    expect((await failures).every((result) => result.status === "rejected")).toBe(true);
    const retried = load(adapter);
    expect(load(adapter)).toBe(retried);
    await expect(retried).resolves.toBe("blob:retried");
    await expect(load(adapter)).resolves.toBe("blob:retried");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    adapter.dispose();
  }
});

function streamResponse(
  url: URL,
  stream: ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
) {
  const result = new Response(stream, { headers: { "content-type": "image/png", ...headers } });
  Object.defineProperty(result, "url", { value: url.href });
  return result;
}

test.each<Record<string, string>>([
  {},
  { "content-length": "3" },
  { "content-length": "3", "content-encoding": "gzip" },
  { "content-length": "invalid" },
])(
  "cancels oversized decoded streams before buffering or hashing them regardless of headers %j",
  async (headers) => {
    let reads = 0;
    const cancel = vi.fn();
    const hash = vi.spyOn(crypto.subtle, "digest");
    const create = vi.spyOn(URL, "createObjectURL");
    vi.stubGlobal("fetch", async (url: URL) =>
      streamResponse(
        url,
        new ReadableStream(
          {
            pull(controller) {
              reads++;
              // An anomalous 16 MiB response; the declared three bytes must stop the first chunk.
              controller.enqueue(new Uint8Array(64 * 1024));
              if (reads === 256) controller.close();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        headers,
      ),
    );
    const adapter = createPreviewAssetAdapter({
      origin: "http://localhost:50001",
      snapshot: inventory(),
    });
    try {
      await expect(load(adapter)).rejects.toThrow("exceeds");
      expect(reads).toBe(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(hash).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
    }
  },
);

test("checks the cumulative stream size and cancels even when cancellation rejects", async () => {
  let reads = 0;
  const cancel = vi.fn().mockRejectedValue(new Error("Cannot cancel"));
  const hash = vi.spyOn(crypto.subtle, "digest");
  const fetcher = vi.fn(async (url: URL) =>
    streamResponse(
      url,
      new ReadableStream(
        {
          pull(controller) {
            controller.enqueue(new Uint8Array([++reads]));
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const adapter = createPreviewAssetAdapter({
    origin: "http://localhost:50001",
    snapshot: inventory(),
  });
  try {
    await expect(load(adapter)).rejects.toThrow("exceeds");
    expect(reads).toBe(4);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(hash).not.toHaveBeenCalled();
    // Size failures, not just network failures, are also retryable.
    fetcher.mockImplementation(async (url) => response(url));
    const url = await load(adapter);
    expect(url).toMatch(/^blob:/u);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    adapter.dispose();
  }
});

test("rejects missing/truncated streams and admits exact streamed bytes without trusting length", async () => {
  const hash = vi.spyOn(crypto.subtle, "digest");
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:exact");
  const adapter = createPreviewAssetAdapter({
    origin: "http://localhost:50001",
    snapshot: inventory(),
  });
  try {
    vi.stubGlobal("fetch", async (url: URL) => streamResponse(url, null));
    await expect(load(adapter)).rejects.toThrow("no byte stream");
    vi.stubGlobal("fetch", async (url: URL) => response(url, bytes.slice(0, 2)));
    await expect(load(adapter)).rejects.toThrow("size was invalid");
    expect(hash).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", async (url: URL) =>
      streamResponse(
        url,
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
        { "content-length": "1", "content-encoding": "gzip" },
      ),
    );
    await expect(load(adapter)).resolves.toBe("blob:exact");
    expect(hash).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    adapter.dispose();
  }
});

test("disposal cancels a stalled read, prevents retry and cannot affect a replacement adapter", async () => {
  const cancel = vi.fn();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher = vi.fn(async (url: URL) =>
    streamResponse(
      url,
      new ReadableStream(
        {
          pull() {
            started();
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new-session");
  const adapter = createPreviewAssetAdapter({
    origin: "http://localhost:50001",
    snapshot: inventory(),
  });
  const token = getPreviewAssetToken(previewAssetToken(adapter, name, "image.src"))!;
  const pending = token.state.load(name, "image.src");
  const failed = expect(pending).rejects.toThrow();
  await reading;
  adapter.dispose();
  await failed;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(create).not.toHaveBeenCalled();
  await expect(token.state.load(name, "image.src")).rejects.toThrow("unavailable");
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async (url) => response(url));
  const next = createPreviewAssetAdapter({
    origin: "http://localhost:50001",
    snapshot: { ...inventory(), sessionId: "replacement" },
  });
  try {
    await expect(load(next)).resolves.toBe("blob:new-session");
  } finally {
    next.dispose();
  }
});

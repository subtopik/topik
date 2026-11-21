import { mkdir } from "node:fs/promises";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createServer } from "node:net";
import { PORTABLE_READS_NOTICE } from "../file-safety";
import { formatPublicCliError } from "../errors";
import {
  installShutdownHandlers,
  parseDevPort,
  startDevServer,
  type StartedDevServer,
} from "./index";

/** What a project-reading command prints with console.error before its own output here. */
const NATIVE_NOTICE = process.platform === "linux" ? [] : [PORTABLE_READS_NOTICE];
// Mocking process.platform cannot make one host's filesystem behave like another's, so both
// portable platforms are simulated on Linux only; elsewhere the native one runs for real.
const PORTABLE_PLATFORMS =
  process.platform === "linux" ? (["darwin", "win32"] as const) : [process.platform];
const WRITE_ORIGIN = "https://write.subtopik.com";
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function addressOf(runningServer: StartedDevServer): AddressInfo {
  const address = runningServer.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Dev server is not listening on a TCP address");
  }
  return address;
}

function requestServer(
  port: number,
  options: {
    host: string;
    origin?: string;
    fetchSite?: string;
    method?: string;
    path?: string;
  },
): Promise<{
  body: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: options.path ?? "/resources",
        method: options.method ?? "GET",
        headers: {
          Host: options.host,
          ...(options.origin ? { Origin: options.origin } : {}),
          ...(options.fetchSite ? { "Sec-Fetch-Site": options.fetchSite } : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ body, headers: res.headers, status: res.statusCode ?? 0 });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("dev command", () => {
  let dir: string;
  let runningServer: StartedDevServer | undefined;

  async function start(options: { allowOrigin?: string } = {}): Promise<number> {
    runningServer = await startDevServer({
      dir,
      port: 0,
      ...options,
    });
    return addressOf(runningServer).port;
  }

  beforeEach(async () => {
    // Commands print progress; a test that checks it spies on console itself.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    dir = await mkdtemp(join(tmpdir(), "topik-dev-"));
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "dev-test-source",
        sources: [{ kind: "collection", config: "collection.yaml" }],
      }),
    );
    await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\nWelcome.\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await runningServer?.close();
    runningServer = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  test("GET /resources returns compiled resources", async () => {
    const port = await start();
    expect(addressOf(runningServer!).address).toBe("127.0.0.1");

    const res = await fetch(`http://127.0.0.1:${port}/resources`, {
      headers: { Origin: WRITE_ORIGIN, "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe(WRITE_ORIGIN);
    expect(res.headers.get("vary")).toBe("Origin, Sec-Fetch-Site");

    const data = (await res.json()) as { resources: { type: string; name: string }[] };
    expect(data.resources).toHaveLength(1);
    expect(data.resources[0].type).toBe("Guide");
    expect(data.resources[0].name).toBe("docs-intro");
  });

  test("rejects untrusted browser origins before exposing resources", async () => {
    const port = await start();

    for (const origin of [
      "https://attacker.example",
      "https://write.subtopik.com.evil.example",
      "http://write.subtopik.com",
      "null",
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}/resources`, {
        headers: { Origin: origin },
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(await res.text()).not.toContain("Welcome");
    }

    const events = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(events.status).toBe(403);
    expect(await events.text()).not.toContain("Welcome");

    for (const fetchSite of ["cross-site", "same-site"]) {
      const noOriginBrowserRequest = await requestServer(port, {
        host: `localhost:${port}`,
        fetchSite,
      });
      expect(noOriginBrowserRequest.status).toBe(403);
      expect(noOriginBrowserRequest.body).not.toContain("Welcome");
    }

    for (const fetchSite of ["same-origin", "none"]) {
      const localBrowserRequest = await requestServer(port, {
        host: `localhost:${port}`,
        fetchSite,
      });
      expect(localBrowserRequest.status).toBe(200);
    }
  });

  test("supports an explicit browser origin override", async () => {
    const customOrigin = "http://localhost:5173";
    const port = await start({ allowOrigin: customOrigin });

    const allowed = await fetch(`http://127.0.0.1:${port}/resources`, {
      headers: { Origin: customOrigin },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(customOrigin);

    const defaultOrigin = await fetch(`http://127.0.0.1:${port}/resources`, {
      headers: { Origin: WRITE_ORIGIN },
    });
    expect(defaultOrigin.status).toBe(403);
  });

  test("maps an occupied port to a public error without the system message", async () => {
    const blocker = createServer();
    await new Promise<void>((resolveListening) => blocker.listen(0, "127.0.0.1", resolveListening));
    const { port } = blocker.address() as AddressInfo;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const failure = await startDevServer({ dir, port }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ id: "dev-port-in-use" });
      expect(formatPublicCliError(failure)).not.toContain("EADDRINUSE");
    } finally {
      await new Promise((resolveClosed) => blocker.close(resolveClosed));
    }
  });

  test("rejects invalid browser origin configuration", async () => {
    await expect(startDevServer({ dir, port: 0, allowOrigin: "*" })).rejects.toThrow(
      "Browser origin configuration is invalid",
    );
    await expect(
      startDevServer({ dir, port: 0, allowOrigin: "https://write.example.com/path" }),
    ).rejects.toThrow("Browser origin configuration is invalid");
  });

  test("keeps config bytes and machine paths out of CLI dev output", async () => {
    const sentinel = "PRIVATE_VALUE";
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "dev-test-source",
        sources: [{ kind: "wiki", config: "wiki.yaml" }],
      }),
    );
    await writeFile(join(dir, "wiki.yaml"), `id: docs\ntitle: [${sentinel}\n`);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => {
      logs.push(values.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...values) => {
      logs.push(values.map(String).join(" "));
    });

    const port = await start();
    const response = await fetch(`http://127.0.0.1:${port}/resources`);
    const state = await response.json();
    expect(state).toMatchObject({
      status: "error",
      generation: null,
      resources: [],
      diagnostics: [
        { id: "config-parse-failed", message: "Configuration file could not be parsed." },
      ],
    });
    const surfaces = JSON.stringify([state, logs]);
    expect(surfaces).not.toContain(sentinel);
    expect(surfaces).not.toContain(dir);
    expect(surfaces).not.toContain(tmpdir());
  });

  test("handles preflight only for the trusted browser origin", async () => {
    const port = await start();

    const allowed = await fetch(`http://127.0.0.1:${port}/resources`, {
      method: "OPTIONS",
      headers: { Origin: WRITE_ORIGIN },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(WRITE_ORIGIN);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");

    const rejected = await fetch(`http://127.0.0.1:${port}/resources`, {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("rejects non-loopback Host headers", async () => {
    const port = await start();

    const allowed = await requestServer(port, {
      host: `localhost:${port}`,
      origin: WRITE_ORIGIN,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe(WRITE_ORIGIN);

    for (const host of [
      `attacker.example:${port}`,
      `localhost.evil.example:${port}`,
      `evil.example@localhost:${port}`,
      "localhost",
    ]) {
      const rejected = await requestServer(port, { host, origin: WRITE_ORIGIN });
      expect(rejected.status).toBe(403);
      expect(rejected.body).not.toContain("Welcome");
    }
  });

  test("GET /events sends the current preview state on connection, and only that", async () => {
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { Origin: WRITE_ORIGIN },
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe(WRITE_ORIGIN);

    // Read the first SSE event from the stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(text.startsWith("event: preview-state\n")).toBe(true);
    expect(text).toContain('"name":"docs-intro"');
    expect(text).not.toMatch(/event: (?:sync|update)\b/u);
  });

  test("GET /resources returns wiki resources", async () => {
    await rm(join(dir, "collection.yaml"));
    await rm(join(dir, "intro.md"));
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "dev-test-source",
        sources: [{ kind: "wiki", config: "wiki.yaml" }],
      }),
    );
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\nWiki page.\n");

    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/resources`);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const data = (await res.json()) as { resources: { type: string; name: string }[] };

    const types = data.resources.map((r) => r.type);
    expect(types).toContain("Wiki");
    expect(types).toContain("WikiPage");
    expect(data.resources.find((r) => r.type === "Wiki")?.name).toBe("docs");
    expect(data.resources.find((r) => r.type === "WikiPage")?.name).toMatch(/^docs-[a-f0-9]{16}$/);
  });

  test("GET and HEAD /blobs/:digest serve only shared compiler payloads", async () => {
    await rm(join(dir, "collection.yaml"));
    await rm(join(dir, "intro.md"));
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "dev-test-source",
        sources: [{ kind: "wiki", config: "wiki.yaml" }],
      }),
    );
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await mkdir(join(dir, "images"), { recursive: true });
    await writeFile(join(dir, "images", "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](images/hero.png)\n");

    const port = await start();

    const resources = (await (await fetch(`http://127.0.0.1:${port}/resources`)).json()) as {
      resources: { type: string; name: string; spec?: { uri?: string } }[];
    };
    const asset = resources.resources.find((resource) => resource.type === "Asset");
    expect(asset?.spec?.uri).toMatch(/^blobs\/[0-9a-f]{64}$/u);

    const assetRes = await fetch(`http://127.0.0.1:${port}/${asset?.spec?.uri}`, {
      headers: { Origin: WRITE_ORIGIN },
    });
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toBe("image/png");
    expect(assetRes.headers.get("content-length")).toBe(String(PNG_BYTES.byteLength));
    expect(assetRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(assetRes.headers.get("access-control-allow-origin")).toBe(WRITE_ORIGIN);
    expect(Buffer.from(await assetRes.arrayBuffer())).toEqual(PNG_BYTES);

    const headRes = await fetch(`http://127.0.0.1:${port}/${asset?.spec?.uri}`, {
      method: "HEAD",
      headers: { Origin: WRITE_ORIGIN },
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-type")).toBe("image/png");
    expect(headRes.headers.get("content-length")).toBe(String(PNG_BYTES.byteLength));
    expect((await headRes.arrayBuffer()).byteLength).toBe(0);

    const assetUri = asset?.spec?.uri;
    if (assetUri === undefined) throw new Error("Compiled Asset URI is missing");
    const digestOffset = "blobs/".length;
    const encodedAlias = `/blobs/%${assetUri
      .charCodeAt(digestOffset)
      .toString(16)
      .padStart(2, "0")}${assetUri.slice(digestOffset + 1)}`;
    const [encodedGetAliasRes, encodedHeadAliasRes] = await Promise.all(
      (["GET", "HEAD"] as const).map((method) =>
        fetch(`http://127.0.0.1:${port}${encodedAlias}`, { method }),
      ),
    );
    expect({ GET: encodedGetAliasRes.status, HEAD: encodedHeadAliasRes.status }).toEqual({
      GET: 404,
      HEAD: 404,
    });

    const digest = assetUri.slice(digestOffset);
    const rawPaths = [
      `/${assetUri}`,
      `/${assetUri}?cache=off`,
      `/blobs/../blobs/${digest}`,
      `/blobs/%2e%2e/blobs/${digest}`,
    ] as const;
    const rawStatuses = Object.fromEntries(
      await Promise.all(
        rawPaths.map(async (path) => {
          const [rawGet, rawHead] = await Promise.all(
            (["GET", "HEAD"] as const).map((method) =>
              requestServer(port, { host: `localhost:${port}`, method, path }),
            ),
          );
          return [path, { GET: rawGet.status, HEAD: rawHead.status }] as const;
        }),
      ),
    );
    expect(rawStatuses).toEqual({
      [`/${assetUri}`]: { GET: 200, HEAD: 200 },
      [`/${assetUri}?cache=off`]: { GET: 200, HEAD: 200 },
      [`/blobs/../blobs/${digest}`]: { GET: 404, HEAD: 404 },
      [`/blobs/%2e%2e/blobs/${digest}`]: { GET: 404, HEAD: 404 },
    });

    const rejectedAssetRes = await fetch(`http://127.0.0.1:${port}/${asset?.spec?.uri}`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(rejectedAssetRes.status).toBe(403);

    const malformedAssetRes = await fetch(`http://127.0.0.1:${port}/blobs/%E0%A4%A`);
    expect(malformedAssetRes.status).not.toBe(500);
    expect(malformedAssetRes.status).toBe(404);

    const legacyAssetRes = await fetch(`http://127.0.0.1:${port}/assets/sha256/${"a".repeat(64)}`);
    expect(legacyAssetRes.status).toBe(404);

    const sourcePathRes = await fetch(`http://127.0.0.1:${port}/images/hero.png`);
    expect(sourcePathRes.status).toBe(404);
  });

  test("serves byte ranges, so browsers can stream and seek video", async () => {
    // An ISO base media file with the mp42 brand, followed by an empty mdat box.
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x14]),
      Buffer.from("ftypmp42\0\0\0\0mp42", "latin1"),
      Buffer.from([0, 0, 0, 8]),
      Buffer.from("mdat", "latin1"),
    ]);
    await writeFile(join(dir, "intro.mp4"), mp4);
    await writeFile(
      join(dir, "intro.md"),
      '# Intro\n\n{% video src="intro.mp4" title="Intro" /%}\n',
    );
    const port = await start();

    const asset = runningServer!.watcher.state.resources.find(
      (resource) => resource.type === "Asset",
    );
    expect(asset?.spec.mediaType).toBe("video/mp4");
    const url = `http://127.0.0.1:${port}/${asset?.spec.uri}`;
    const get = (range?: string, method = "GET") =>
      fetch(url, {
        method,
        headers: { Origin: WRITE_ORIGIN, ...(range === undefined ? {} : { Range: range }) },
      });

    const whole = await get();
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(mp4);

    const cases = [
      ["bytes=4-11", 4, 11],
      ["bytes=20-", 20, 27],
      ["bytes=-8", 20, 27],
      ["bytes=24-1000", 24, 27],
    ] as const;
    for (const [range, start, end] of cases) {
      const partial = await get(range);
      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-range")).toBe(`bytes ${start}-${end}/${mp4.byteLength}`);
      expect(partial.headers.get("content-length")).toBe(String(end - start + 1));
      expect(partial.headers.get("content-type")).toBe("video/mp4");
      expect(partial.headers.get("access-control-allow-origin")).toBe(WRITE_ORIGIN);
      expect(Buffer.from(await partial.arrayBuffer())).toEqual(mp4.subarray(start, end + 1));
    }

    // The range unit is case-insensitive.
    const mixedCase = await get("Bytes=4-11");
    expect(mixedCase.status).toBe(206);
    expect(Buffer.from(await mixedCase.arrayBuffer())).toEqual(mp4.subarray(4, 12));

    // HEAD describes the whole payload; ranges apply to GET only.
    const head = await get("bytes=0-3", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(mp4.byteLength));
    expect(head.headers.get("content-range")).toBeNull();
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    // Payloads carry no validator, so If-Range never matches and the whole payload follows.
    const conditional = await fetch(url, {
      headers: { Origin: WRITE_ORIGIN, Range: "bytes=4-11", "If-Range": '"stale"' },
    });
    expect(conditional.status).toBe(200);
    expect((await conditional.arrayBuffer()).byteLength).toBe(mp4.byteLength);

    for (const range of ["bytes=28-", "bytes=-0"]) {
      const unsatisfiable = await get(range);
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${mp4.byteLength}`);
    }

    // Malformed and multiple ranges are ignored, as HTTP allows.
    for (const range of ["bytes=0-1,4-5", "bytes=5-2", "items=0-1", "bytes=-"]) {
      const ignored = await get(range);
      expect(ignored.status).toBe(200);
      expect((await ignored.arrayBuffer()).byteLength).toBe(mp4.byteLength);
    }
  });

  test("serves proven opaque downloads with enforced non-inline headers", async () => {
    await writeFile(join(dir, "manual.bin"), "offline bytes");
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Download](manual.bin)\n");
    const port = await start();

    const asset = runningServer!.watcher.state.resources.find(
      (resource) => resource.type === "Asset",
    );
    const response = await fetch(`http://127.0.0.1:${port}/${asset?.spec.uri}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("offline bytes");
  });

  test("refreshes the dev snapshot when a dot-prefixed asset changes", async () => {
    await mkdir(join(dir, ".images"));
    await writeFile(join(dir, ".images", "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](.images/hero.png)\n");

    const port = await start();
    const initialPayload = runningServer!.watcher.state.payloads[0];
    expect(initialPayload).toBeDefined();

    const changedBytes = Uint8Array.from(PNG_BYTES);
    changedBytes[changedBytes.length - 1] ^= 1;
    const updated = new Promise<void>((resolve) => {
      runningServer!.watcher.on("preview-state", (state) => {
        if (state.status === "ready" && state.payloads[0]?.integrity !== initialPayload.integrity)
          resolve();
      });
    });

    // Let chokidar finish establishing its recursive watches before changing the asset.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(join(dir, ".images", "hero.png"), changedBytes);
    await updated;

    const resourcesResponse = await fetch(`http://127.0.0.1:${port}/resources`);
    const resources = (await resourcesResponse.json()) as {
      payloads: { integrity: string; path: string }[];
    };
    const refreshed = resources.payloads[0];
    expect(refreshed?.integrity).not.toBe(initialPayload?.integrity);

    const assetResponse = await fetch(`http://127.0.0.1:${port}/${refreshed?.path}`);
    expect(assetResponse.status).toBe(200);
    expect(Buffer.from(await assetResponse.arrayBuffer())).toEqual(Buffer.from(changedBytes));
  }, 10_000);

  test("serves only the proven snapshot after a source asset becomes an outside symlink", async () => {
    const external = await mkdtemp(join(tmpdir(), "topik-dev-secret-"));
    try {
      await mkdir(join(dir, "images"), { recursive: true });
      const assetPath = join(dir, "images", "hero.png");
      await writeFile(assetPath, PNG_BYTES);
      await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](images/hero.png)\n");
      await writeFile(join(external, "secret.png"), "secret bytes");

      const port = await start();

      const payloadPath = [...runningServer!.watcher.payloads.keys()][0];
      expect(payloadPath).toBeDefined();

      await rm(assetPath);
      await symlink(join(external, "secret.png"), assetPath);

      const response = await fetch(`http://127.0.0.1:${port}/${payloadPath}`);
      expect(response.status).toBe(200);
      const responseBytes = Buffer.from(await response.arrayBuffer());
      expect(responseBytes).toEqual(PNG_BYTES);
      expect(responseBytes.toString()).not.toContain("secret bytes");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  test("returns 404 for unknown routes", async () => {
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  test("returns 400 for malformed request targets", async () => {
    const port = await start();

    const response = await requestServer(port, {
      host: `localhost:${port}`,
      path: "http://[",
    });
    expect(response.status).toBe(400);
    expect(response.body).toBe("Bad Request");

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  });

  test("prints located compile diagnostics and publishes them with root-relative paths", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Missing](#missing)\n");
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((...values) => {
      errors.push(values.map(String).join(" "));
    });

    const port = await start();

    expect(errors).toEqual([
      ...NATIVE_NOTICE,
      "Compile error:",
      expect.stringMatching(/^intro\.md:3 error [a-z-]+: /u),
    ]);
    const state = await (await fetch(`http://127.0.0.1:${port}/resources`)).json();
    expect(state).toMatchObject({
      status: "error",
      resources: [],
      diagnostics: [{ severity: "error", location: { path: "intro.md", line: 3 } }],
    });
    expect(JSON.stringify(state)).not.toContain(dir);
  });

  test("applies the --links policy to preview compilations and prints their warnings", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Missing](#missing)\n");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...values) => {
      warnings.push(values.map(String).join(" "));
    });

    runningServer = await startDevServer({ dir, port: 0, links: "warning" });

    expect(runningServer.watcher.state.status).toBe("ready");
    expect(runningServer.watcher.state.resources).toHaveLength(1);
    expect(warnings).toContainEqual(expect.stringMatching(/^intro\.md:3 warning [a-z-]+: /u));
  });

  test("fails fast when the source directory does not exist", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const failure = await startDevServer({ dir: join(dir, "missing"), port: 0 }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ id: "dev-source-access-failed" });
    expect(formatPublicCliError(failure)).toBe(
      "Dev server source directory does not exist or could not be accessed.",
    );
    expect(log).not.toHaveBeenCalled();
  });

  test.each(PORTABLE_PLATFORMS)(
    "serves on %s with portable reads and one notice",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      runningServer = await startDevServer({ dir, port: 0 });

      expect(runningServer.watcher.state.status).toBe("ready");
      expect(error.mock.calls).toEqual([[PORTABLE_READS_NOTICE]]);
    },
  );

  test.each(PORTABLE_PLATFORMS)(
    "stops on %s with the platform requirement when anchored reads are required",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const failure = await startDevServer({ dir, port: 0, fileSafety: "anchored" }).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(failure).toMatchObject({ id: "project-platform-unsupported" });
      await rm(join(dir, ".topik.yaml"));
      await expect(startDevServer({ dir, port: 0, fileSafety: "anchored" })).rejects.toMatchObject({
        id: "project-platform-unsupported",
      });
      expect(formatPublicCliError(failure)).toBe(
        "--file-safety anchored requires descriptor-anchored file reads, which only Linux provides. Use --file-safety portable on a workspace you trust, or run on Linux, for example in WSL 2 or a Linux container.",
      );
      expect(error).not.toHaveBeenCalled();
    },
  );
});

test("HTTP and SSE share complete state; reconnect receives existing failure; health binds session", async () => {
  // The server prints its progress and the manifest error; this test reads the wire state.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const dir = await mkdtemp(join(tmpdir(), "preview-wire-"));
  await writeFile(
    join(dir, ".topik.yaml"),
    JSON.stringify({ version: 1, namespace: "wire", sources: [] }),
  );
  const running = await startDevServer({ dir, port: 0 });
  const origin = `http://127.0.0.1:${running.port}`;
  const controllers: AbortController[] = [];
  async function firstState() {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let data = "";
    while (!data.includes("\n\n")) data += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    const frame = data.split("\n\n")[0];
    expect(frame).toMatch(/^event: preview-state\ndata: /u);
    return JSON.parse(frame.slice(frame.indexOf("data: ") + 6));
  }
  try {
    const health = (await (await fetch(`${origin}/health`)).json()) as { sessionId: string };
    expect(health).toMatchObject({
      capabilities: ["topik-preview/2"],
      sessionId: running.watcher.state.sessionId,
      version: expect.any(String),
    });
    const snapshot = await (await fetch(`${origin}/resources`)).json();
    expect(await firstState()).toEqual(snapshot);
    const failed = new Promise<void>((resolve) =>
      running.watcher.on("preview-state", (state) => {
        if (state.status === "error") resolve();
      }),
    );
    await writeFile(join(dir, ".topik.yaml"), "private: [invalid");
    await failed;
    expect(await firstState()).toEqual(await (await fetch(`${origin}/resources`)).json());
    expect(await firstState()).toMatchObject({ status: "error", generation: 1, resources: [] });
    const digest = "a".repeat(64);
    for (const query of [
      "sessionId=other&generation=1",
      `sessionId=${health.sessionId}`,
      `sessionId=${health.sessionId}&generation=0`,
      `sessionId=${health.sessionId}&sessionId=${health.sessionId}&generation=1`,
    ]) {
      expect((await fetch(`${origin}/blobs/${digest}?${query}`)).status).toBe(409);
    }
  } finally {
    controllers.forEach((controller) => controller.abort());
    await running.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

describe("parseDevPort", () => {
  test.each([
    ["0", 0],
    ["50001", 50001],
    ["65535", 65535],
  ])("accepts %s", (value, port) => {
    expect(parseDevPort(value)).toBe(port);
  });

  test.each(["", "abc", "50001abc", "1e3", "-1", "+80", " 80", "0x50", "65536", "123456"])(
    "rejects %j",
    (value) => {
      expect(() => parseDevPort(value)).toThrow(
        expect.objectContaining({ id: "dev-port-invalid" }),
      );
    },
  );
});

describe("installShutdownHandlers", () => {
  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "closes the server once and exits 0 on %s",
    async (signal) => {
      const close = vi.fn(() => Promise.resolve());
      const exited = new Promise<number>((resolveExit) => {
        const uninstall = installShutdownHandlers({ close }, (code) => {
          uninstall();
          resolveExit(code);
        });
      });

      process.emit(signal, signal);
      expect(await exited).toBe(0);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  test("reports a rejected close as a public error and exits 1", async () => {
    const sentinel = "PRIVATE_VALUE";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const close = vi.fn(() => Promise.reject(new Error(`close failed at /tmp/${sentinel}`)));
      const exited = new Promise<number>((resolveExit) => {
        const uninstall = installShutdownHandlers({ close }, (code) => {
          uninstall();
          resolveExit(code);
        });
      });

      process.emit("SIGTERM", "SIGTERM");
      expect(await exited).toBe(1);
      await new Promise((resolveTick) => setImmediate(resolveTick));
      expect(error).toHaveBeenCalledWith("Topik command failed.");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      vi.restoreAllMocks();
    }
  });
});

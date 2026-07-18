import { mkdir } from "node:fs/promises";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { startDevServer, type StartedDevServer } from "./index";

const WRITE_ORIGIN = "https://write.subtopik.com";

function addressOf(runningServer: StartedDevServer): AddressInfo {
  const address = runningServer.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Dev server is not listening on a TCP address");
  }
  return address;
}

function requestServer(
  port: number,
  options: { host: string; origin?: string; method?: string; path?: string },
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
    runningServer = await startDevServer({ dir, port: 0, ...options });
    return addressOf(runningServer).port;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-dev-"));
    await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\nWelcome.\n");
  });

  afterEach(async () => {
    await runningServer?.close();
    runningServer = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  test("GET /resources returns compiled resources", async () => {
    const port = await start();
    expect(addressOf(runningServer!).address).toBe("127.0.0.1");

    const res = await fetch(`http://127.0.0.1:${port}/resources`, {
      headers: { Origin: WRITE_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe(WRITE_ORIGIN);
    expect(res.headers.get("vary")).toBe("Origin");

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

  test("rejects invalid browser origin configuration", async () => {
    await expect(startDevServer({ dir, port: 0, allowOrigin: "*" })).rejects.toThrow(
      "Invalid browser origin",
    );
    await expect(
      startDevServer({ dir, port: 0, allowOrigin: "https://write.example.com/path" }),
    ).rejects.toThrow("Invalid browser origin");
  });

  test("handles preflight only for the trusted browser origin", async () => {
    const port = await start();

    const allowed = await fetch(`http://127.0.0.1:${port}/resources`, {
      method: "OPTIONS",
      headers: { Origin: WRITE_ORIGIN },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(WRITE_ORIGIN);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");

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

  test("GET /events sends sync event on connection", async () => {
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

    expect(text).toContain("event: sync");
    expect(text).toContain('"Guide/docs-intro"');
  });

  test("GET /resources returns wiki resources", async () => {
    await rm(join(dir, "collection.yaml"));
    await rm(join(dir, "intro.md"));
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

  test("GET /assets/:name serves compiled assets without exposing source routes", async () => {
    await rm(join(dir, "collection.yaml"));
    await rm(join(dir, "intro.md"));
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await mkdir(join(dir, "images"), { recursive: true });
    await writeFile(join(dir, "images", "hero.png"), "not really a png");
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](./images/hero.png)\n");

    const port = await start();

    const resources = (await (await fetch(`http://127.0.0.1:${port}/resources`)).json()) as {
      resources: { type: string; name: string }[];
    };
    const asset = resources.resources.find((r) => r.type === "Asset");
    expect(asset).toBeDefined();

    const assetRes = await fetch(`http://127.0.0.1:${port}/assets/${asset!.name}`, {
      headers: { Origin: WRITE_ORIGIN },
    });
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toBe("image/png");
    expect(assetRes.headers.get("access-control-allow-origin")).toBe(WRITE_ORIGIN);
    expect(await assetRes.text()).toBe("not really a png");

    const rejectedAssetRes = await fetch(`http://127.0.0.1:${port}/assets/${asset!.name}`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(rejectedAssetRes.status).toBe(403);
    expect(await rejectedAssetRes.text()).not.toContain("not really a png");

    const malformedAssetRes = await fetch(`http://127.0.0.1:${port}/assets/%E0%A4%A`);
    expect(malformedAssetRes.status).not.toBe(500);
    expect(malformedAssetRes.status).toBe(404);

    const sourcePathRes = await fetch(`http://127.0.0.1:${port}/images/hero.png`);
    expect(sourcePathRes.status).toBe(404);
  });

  test("does not serve a compiled asset after it is replaced by an outside symlink", async () => {
    const external = await mkdtemp(join(tmpdir(), "topik-dev-secret-"));
    try {
      await mkdir(join(dir, "images"), { recursive: true });
      const assetPath = join(dir, "images", "hero.png");
      await writeFile(assetPath, "public asset");
      await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](./images/hero.png)\n");
      await writeFile(join(external, "secret.png"), "secret bytes");

      const port = await start();

      const resources = (await (await fetch(`http://127.0.0.1:${port}/resources`)).json()) as {
        resources: { type: string; name: string }[];
      };
      const asset = resources.resources.find((resource) => resource.type === "Asset");
      expect(asset).toBeDefined();

      await rm(assetPath);
      await symlink(join(external, "secret.png"), assetPath);

      const response = await fetch(`http://127.0.0.1:${port}/assets/${asset!.name}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("secret bytes");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  test("returns 404 for unknown routes", async () => {
    const port = await start();

    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { dev } from "./index";

type DevCommand = {
  handler?: (options: { dir: string; port: string }) => Promise<void>;
};

async function waitForServer(port: number, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/resources`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Server did not start in time");
}

describe("dev command", () => {
  let dir: string;
  let port: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-dev-"));
    // Use a random high port to avoid conflicts
    port = 50100 + Math.floor(Math.random() * 900);
    await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\nWelcome.\n");
  });

  afterEach(async () => {
    // Kill the server by closing all connections on the port
    try {
      await fetch(`http://localhost:${port}/resources`, { signal: AbortSignal.timeout(100) });
    } catch {
      // ignore
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("GET /resources returns compiled resources", async () => {
    void (dev as DevCommand).handler?.({ dir, port: String(port) });
    await waitForServer(port);

    const res = await fetch(`http://localhost:${port}/resources`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const data = (await res.json()) as { resources: { type: string; name: string }[] };
    expect(data.resources).toHaveLength(1);
    expect(data.resources[0].type).toBe("Guide");
    expect(data.resources[0].name).toBe("docs-intro");
  });

  test("GET /events sends sync event on connection", async () => {
    void (dev as DevCommand).handler?.({ dir, port: String(port) });
    await waitForServer(port);

    const res = await fetch(`http://localhost:${port}/events`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Read the first SSE event from the stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    void reader.cancel();

    expect(text).toContain("event: sync");
    expect(text).toContain('"Guide/docs-intro"');
  });

  test("GET /resources returns wiki resources", async () => {
    await rm(join(dir, "collection.yaml"));
    await rm(join(dir, "intro.md"));
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\nWiki page.\n");

    void (dev as DevCommand).handler?.({ dir, port: String(port) });
    await waitForServer(port);

    const res = await fetch(`http://localhost:${port}/resources`);
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

    void (dev as DevCommand).handler?.({ dir, port: String(port) });
    await waitForServer(port);

    const resources = (await (await fetch(`http://localhost:${port}/resources`)).json()) as {
      resources: { type: string; name: string }[];
    };
    const asset = resources.resources.find((r) => r.type === "Asset");
    expect(asset).toBeDefined();

    const assetRes = await fetch(`http://localhost:${port}/assets/${asset!.name}`);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toBe("image/png");
    expect(await assetRes.text()).toBe("not really a png");

    const malformedAssetRes = await fetch(`http://localhost:${port}/assets/%E0%A4%A`);
    expect(malformedAssetRes.status).not.toBe(500);
    expect(malformedAssetRes.status).toBe(404);

    const sourcePathRes = await fetch(`http://localhost:${port}/images/hero.png`);
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

      void (dev as DevCommand).handler?.({ dir, port: String(port) });
      await waitForServer(port);

      const resources = (await (await fetch(`http://localhost:${port}/resources`)).json()) as {
        resources: { type: string; name: string }[];
      };
      const asset = resources.resources.find((resource) => resource.type === "Asset");
      expect(asset).toBeDefined();

      await rm(assetPath);
      await symlink(join(external, "secret.png"), assetPath);

      const response = await fetch(`http://localhost:${port}/assets/${asset!.name}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("secret bytes");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  test("returns 404 for unknown routes", async () => {
    void (dev as DevCommand).handler?.({ dir, port: String(port) });
    await waitForServer(port);

    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(data.resources.find((r) => r.type === "WikiPage")?.name).toBe("docs-intro");
  });

  test("returns 404 for unknown routes", async () => {
    void (dev as DevCommand).handler?.({ dir, port: String(port) });
    await waitForServer(port);

    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});

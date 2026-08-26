import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request, type IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";

const ASTRO_CLI = join(import.meta.dirname, "../node_modules/.bin/astro");
const WORKSPACE_NODE_MODULES = join(import.meta.dirname, "../node_modules");
const TOPIK_ASTRO_SOURCE = pathToFileURL(join(import.meta.dirname, "index.ts")).href;
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const HTTP_EXCHANGE_TIMEOUT_MS = 2_000;
const STATUS_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const roots = new Set<string>();
const servers = new Set<DevelopmentServer>();

interface DevelopmentResponse {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}

interface DevelopmentServer {
  child: ChildProcess;
  output: () => string;
  port: number;
  root: string;
  spawnError?: Error;
}

interface DevelopmentServerOptions {
  onSpawn?: (child: ChildProcess) => void;
  port?: number;
}

describe("Astro development Asset delivery", () => {
  afterEach(cleanupDevelopmentFixtures);

  test("bounds stalled and aborted development exchanges", async () => {
    const server = createHttpServer((req, res) => {
      if (req.url === "/stalled") return;
      res.writeHead(200, { "Content-Length": "2" });
      res.flushHeaders();
      res.write("x");
      setImmediate(() => res.destroy());
    });
    await listen(server, 0);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      await expect(requestDevelopmentServer(port, "/stalled", "GET", 50)).rejects.toThrow(
        /timed out/u,
      );
      await expect(requestDevelopmentServer(port, "/aborted", "GET")).rejects.toThrow(/response/u);
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });

  test("fails without polling another server when the requested port is occupied", async () => {
    const root = await createFixture();
    const port = await freePort();
    let requests = 0;
    let childPid: number | undefined;
    const occupant = createHttpServer((_req, res) => {
      requests++;
      res.end("not Astro");
    });
    await listen(occupant, port);

    try {
      await expect(
        startDevelopmentServer(root, {
          onSpawn: (child) => {
            childPid = child.pid;
          },
          port,
        }),
      ).rejects.toThrow(/exited before becoming ready/u);
      expect(requests).toBe(0);
      expect(servers.size).toBe(0);
      if (childPid !== undefined) expect(processGroupIsAlive(childPid)).toBe(false);
    } finally {
      occupant.closeAllConnections();
      await closeServer(occupant);
    }
  }, 10_000);

  test("a real development server delivers only the current compiler snapshot", async () => {
    const root = await createFixture();
    const server = await startDevelopmentServer(root);

    try {
      const initialDigest = digest(PNG_BYTES);
      const initialPath = `/blobs/${initialDigest}`;
      await expectPageAssets(server, [initialPath], []);
      await expectAssetResponse(server, initialPath, PNG_BYTES, "image/png");

      for (const method of ["GET", "HEAD"] as const) {
        const query = await requestDevelopmentServer(
          server.port,
          `${initialPath}?cache=off`,
          method,
        );
        expect(query.status).toBe(200);
        if (method === "GET") expect(query.body).toEqual(PNG_BYTES);
        else expect(query.body).toHaveLength(0);
      }

      const encodedDigest = `%${initialDigest
        .charCodeAt(0)
        .toString(16)
        .padStart(2, "0")}${initialDigest.slice(1)}`;
      for (const rawPath of [
        "/hero.png",
        `/blobs/${"a".repeat(64)}`,
        `/assets/sha256/${initialDigest}`,
        `/blobs/${encodedDigest}`,
        `/blobs/%5c${initialDigest}`,
        `/blobs/../blobs/${initialDigest}`,
        `/blobs/%2e%2e/blobs/${initialDigest}`,
        `/blobs/..\\blobs/${initialDigest}`,
      ]) {
        for (const method of ["GET", "HEAD"] as const) {
          const rejected = await requestDevelopmentServer(server.port, rawPath, method);
          expect(rejected.status, `${method} ${rawPath}`).toBe(404);
          expect(rejected.body).not.toEqual(PNG_BYTES);
        }
      }
      for (const method of ["POST", "PUT", "DELETE"] as const) {
        const rejected = await requestDevelopmentServer(server.port, initialPath, method);
        expect(rejected.status, `${method} ${initialPath}`).toBe(404);
        expect(rejected.body).not.toEqual(PNG_BYTES);
      }

      const replacementBytes = Buffer.concat([PNG_BYTES, Buffer.from([0])]);
      const replacementPath = `/blobs/${digest(replacementBytes)}`;
      await writeFile(join(root, "content/guides/hero.png"), replacementBytes);
      await updateContentConfig(root, 1);
      await waitForStatus(server, replacementPath, 200);
      await expectPageAssets(server, [replacementPath], [initialPath]);
      await expectAssetResponse(server, replacementPath, replacementBytes, "image/png");
      await expectAssetNotServed(server, initialPath, PNG_BYTES);

      await writeFile(join(root, "content/guides/intro.md"), "# Guide\n\nNo Assets.\n");
      await updateContentConfig(root, 2);
      await waitForStatus(server, replacementPath, 404);
      await expectPageAssets(server, [], [replacementPath]);
      await expectAssetNotServed(server, replacementPath, replacementBytes);
      expect((await requestDevelopmentServer(server.port, "/hero.png", "GET")).status).toBe(404);

      await writeFile(join(root, "content/guides/intro.md"), "# Guide\n\n![Hero](hero.png)\n");
      await updateContentConfig(root, 3);
      await waitForStatus(server, replacementPath, 200);
      await expectPageAssets(server, [replacementPath], []);
      await writeFile(join(root, "content/guides/active.svg"), '<svg onload="alert(1)" />');
      await writeFile(join(root, "content/guides/intro.md"), "# Guide\n\n![Active](active.svg)\n");
      await updateContentConfig(root, 4);
      await waitForStatus(server, replacementPath, 404);
      await expectPageAssets(server, [], [replacementPath]);
      await expectAssetNotServed(server, replacementPath, replacementBytes);
      expect((await requestDevelopmentServer(server.port, "/active.svg", "GET")).status).toBe(404);
      expect(server.child.exitCode).toBeNull();
    } finally {
      await releaseDevelopmentServer(server);
    }
  }, 30_000);
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "topik-astro-development-"));
  roots.add(root);
  await symlink(WORKSPACE_NODE_MODULES, join(root, "node_modules"), "dir");
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "content/guides"), { recursive: true });
  await writeFile(join(root, "content/guides/collection.yaml"), "id: guides\ntitle: Guides\n");
  await writeFile(join(root, "content/guides/hero.png"), PNG_BYTES);
  await writeFile(join(root, "content/guides/intro.md"), "# Guide\n\n![Hero](hero.png)\n");
  await writeFile(
    join(root, "topik-loaders.mjs"),
    `import { topikGuidesLoader } from ${JSON.stringify(TOPIK_ASTRO_SOURCE)};\nexport const guidesLoader = topikGuidesLoader({ dir: new URL("./content/guides", import.meta.url).pathname, sourceNamespace: "development-guides" });\n`,
  );
  await updateContentConfig(root, 0);
  await writeFile(
    join(root, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";\nimport { topik } from ${JSON.stringify(TOPIK_ASTRO_SOURCE)};\nimport { guidesLoader } from "./topik-loaders.mjs";\nexport default defineConfig({ vite: { server: { strictPort: true } }, integrations: [topik({ loaders: [guidesLoader] })] });\n`,
  );
  await writeFile(
    join(root, "src/pages/index.astro"),
    `---\nimport { getCollection } from "astro:content";\nimport { guidesLoader } from "../../topik-loaders.mjs";\nconst entries = await getCollection("guides");\nconst urls = guidesLoader.getAssets().map((asset) => guidesLoader.resolveAsset(asset.name));\n---\n{entries.map((entry) => <pre>{entry.body}</pre>)}\n{urls.map((url) => <a href={url}>{url}</a>)}\n`,
  );
  return root;
}

async function updateContentConfig(root: string, revision: number): Promise<void> {
  await writeFile(
    join(root, "src/content.config.mjs"),
    `import { defineCollection } from "astro:content";\nimport { guidesLoader } from "../topik-loaders.mjs";\nexport const fixtureRevision = ${revision};\nexport const collections = { guides: defineCollection({ loader: guidesLoader }) };\n`,
  );
}

async function startDevelopmentServer(
  root: string,
  options: DevelopmentServerOptions = {},
): Promise<DevelopmentServer> {
  const port = options.port ?? (await freePort());
  let output = "";
  const child = spawn(ASTRO_CLI, ["dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ASTRO_DEV_BACKGROUND: "1",
      NODE_ENV: "development",
      NO_COLOR: "1",
      VITEST: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appendOutput = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-100_000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  const server: DevelopmentServer = {
    child,
    output: () => output.replaceAll(root, "<fixture>"),
    port,
    root,
  };
  child.once("error", (error) => {
    server.spawnError = error;
  });
  servers.add(server);
  try {
    options.onSpawn?.(child);
    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    await waitForAstroOwnership(server, deadline);
    await waitForStatusUntil(server, "/", 200, deadline);
    return server;
  } catch (error) {
    await releaseDevelopmentServer(server);
    throw error;
  }
}

async function releaseDevelopmentServer(server: DevelopmentServer): Promise<void> {
  await stopDevelopmentServer(server);
  servers.delete(server);
}

async function stopDevelopmentServer(server: DevelopmentServer): Promise<void> {
  const { child } = server;
  if (child.pid === undefined) return;
  if (!processGroupIsAlive(child.pid)) return;
  killDevelopmentProcess(child, "SIGTERM");
  if (!(await waitForProcessGroupExit(child.pid, 3_000))) {
    killDevelopmentProcess(child, "SIGKILL");
  }
  if (!(await waitForProcessGroupExit(child.pid, 2_000))) {
    throw new Error("Astro development process did not terminate");
  }
}

async function cleanupDevelopmentFixtures(): Promise<void> {
  const stopped = await Promise.allSettled([...servers].map(stopDevelopmentServer));
  servers.clear();
  const removed = await Promise.allSettled(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
  const errors = [...stopped, ...removed]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, "Development fixture cleanup failed");
}

function killDevelopmentProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!processGroupIsAlive(pid)) return true;
    await delay(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  return !processGroupIsAlive(pid);
}

async function expectAssetResponse(
  server: DevelopmentServer,
  path: string,
  bytes: Buffer,
  mediaType: string,
): Promise<void> {
  const get = await requestDevelopmentServer(server.port, path, "GET");
  expect(get.status).toBe(200);
  expect(get.body).toEqual(bytes);
  expect(get.headers["content-type"]).toBe(mediaType);
  expect(get.headers["content-length"]).toBe(String(bytes.byteLength));
  expect(get.headers["x-content-type-options"]).toBe("nosniff");

  const head = await requestDevelopmentServer(server.port, path, "HEAD");
  expect(head.status).toBe(200);
  expect(head.body).toHaveLength(0);
  expect(head.headers["content-type"]).toBe(mediaType);
  expect(head.headers["content-length"]).toBe(String(bytes.byteLength));
  expect(head.headers["x-content-type-options"]).toBe("nosniff");
}

async function expectAssetNotServed(
  server: DevelopmentServer,
  path: string,
  bytes: Buffer,
): Promise<void> {
  for (const method of ["GET", "HEAD"] as const) {
    const response = await requestDevelopmentServer(server.port, path, method);
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(response.body).not.toEqual(bytes);
  }
}

async function expectPageAssets(
  server: DevelopmentServer,
  present: readonly string[],
  absent: readonly string[],
): Promise<void> {
  const page = await requestDevelopmentServer(server.port, "/", "GET");
  expect(page.status).toBe(200);
  const html = page.body.toString("utf8");
  for (const path of present) expect(html).toContain(`href="${path}"`);
  for (const path of absent) expect(html).not.toContain(path);
}

async function requestDevelopmentServer(
  port: number,
  path: string,
  method: string,
  timeoutMilliseconds = HTTP_EXCHANGE_TIMEOUT_MS,
): Promise<DevelopmentResponse> {
  return new Promise((resolve, reject) => {
    let activeResponse: IncomingMessage | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let responseSize = 0;
    const settle = (error: Error | undefined, response?: DevelopmentResponse) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (error !== undefined) reject(error);
      else resolve(response!);
    };
    const req = request({ hostname: "127.0.0.1", method, path, port }, (res) => {
      activeResponse = res;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        responseSize += chunk.byteLength;
        if (responseSize > MAX_RESPONSE_BYTES) {
          settle(new Error("Astro development response exceeded the size limit"));
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.once("aborted", () => settle(new Error("Astro development response was aborted")));
      res.once("error", () => settle(new Error("Astro development response failed")));
      res.once("close", () => {
        if (!res.complete) settle(new Error("Astro development response closed early"));
      });
      res.once("end", () =>
        settle(undefined, {
          body: Buffer.concat(chunks),
          headers: res.headers,
          status: res.statusCode ?? 0,
        }),
      );
    });
    req.once("error", () => settle(new Error("Astro development request failed")));
    timeout = setTimeout(() => {
      const error = new Error("Astro development request timed out");
      settle(error);
      activeResponse?.destroy(error);
      req.destroy(error);
    }, timeoutMilliseconds);
    req.end();
  });
}

async function waitForStatus(
  server: DevelopmentServer,
  path: string,
  expectedStatus: number,
  timeoutMilliseconds = STATUS_TIMEOUT_MS,
): Promise<void> {
  await waitForStatusUntil(server, path, expectedStatus, Date.now() + timeoutMilliseconds);
}

async function waitForStatusUntil(
  server: DevelopmentServer,
  path: string,
  expectedStatus: number,
  deadline: number,
): Promise<void> {
  let observation = "no response";
  while (Date.now() < deadline) {
    assertDevelopmentProcessRunning(server);
    try {
      const response = await requestDevelopmentServer(
        server.port,
        path,
        "GET",
        Math.min(HTTP_EXCHANGE_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
      );
      if (response.status === expectedStatus) return;
      observation = `HTTP ${response.status}: ${response.body.toString("utf8").slice(0, 200)}`;
    } catch (error) {
      observation = error instanceof Error ? error.message : "request error";
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `Timed out waiting for Astro development response (last observation: ${observation}).\n${server.output()}`,
  );
}

async function waitForAstroOwnership(server: DevelopmentServer, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    assertDevelopmentProcessRunning(server);
    const ownership = await readAstroOwnership(server.root);
    if (ownership !== undefined) {
      if (ownership.pid !== server.child.pid || ownership.port !== server.port) {
        throw new Error(
          `Astro development ownership did not match the spawned process.\n${server.output()}`,
        );
      }
      return;
    }
    await delay(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for Astro development ownership.\n${server.output()}`);
}

async function readAstroOwnership(
  root: string,
): Promise<{ pid: number; port: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, ".astro/dev.json"), "utf8")) as {
      pid?: unknown;
      port?: unknown;
    };
    return typeof value.pid === "number" && typeof value.port === "number"
      ? { pid: value.pid, port: value.port }
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw new Error("Failed to read Astro development ownership");
  }
}

function assertDevelopmentProcessRunning(server: DevelopmentServer): void {
  if (server.spawnError !== undefined) {
    throw new Error(`Astro failed to spawn.\n${server.output()}`);
  }
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    throw new Error(`Astro exited before becoming ready.\n${server.output()}`);
  }
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await closeServer(server);
  return port;
}

function listen(
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createNetServer>,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function closeServer(
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createNetServer>,
): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

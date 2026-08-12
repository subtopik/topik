import { execFile } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { LoaderContext } from "astro/loaders";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { topikGuidesLoader } from "./guides";
import { topik, type TopikAssetLoader } from "./integration";
import { topikWikiLoader } from "./wiki";

const execFileAsync = promisify(execFile);
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const PDF_BYTES = Buffer.from("%PDF-1.7\nmanual\n");

interface MockResponse {
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
}

function createMiddleware(loaders: TopikAssetLoader[]) {
  let middleware:
    | ((req: { method?: string; url?: string }, res: MockResponse, next: () => void) => void)
    | undefined;

  const integration = topik({ loaders });
  void integration.hooks["astro:server:setup"]?.({
    server: {
      middlewares: {
        use(
          fn: (req: { method?: string; url?: string }, res: MockResponse, next: () => void) => void,
        ) {
          middleware = fn;
        },
      },
    },
  } as never);

  if (!middleware) throw new Error("Expected astro:server:setup to register a middleware");
  return middleware;
}

function createResponse(): MockResponse {
  return { end: vi.fn(), setHeader: vi.fn() };
}

function createMockContext() {
  const entries = new Map<string, { id: string; data: Record<string, unknown>; body?: string }>();
  return {
    store: {
      clear: () => entries.clear(),
      set: (entry: { id: string; data: Record<string, unknown>; body?: string }) =>
        entries.set(entry.id, entry),
    },
    logger: { info: () => {} },
    generateDigest: (data: string) => String(data.length),
    entries,
  } as unknown as LoaderContext & { entries: typeof entries };
}

async function dispatch(
  middleware: ReturnType<typeof createMiddleware>,
  url: string,
  method = "GET",
) {
  const response = createResponse();
  const next = vi.fn();
  middleware({ method, url }, response, next);
  await vi.waitFor(() => expect(response.end.mock.calls.length + next.mock.calls.length).toBe(1));
  return { next, response };
}

async function requestRawDevelopmentServer(
  port: number,
  path: string,
  method: "GET" | "HEAD",
): Promise<{ body: Buffer; status: number }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", method, path, port }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ body: Buffer.concat(chunks), status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function startRawDevelopmentServer(
  middleware: ReturnType<typeof createMiddleware>,
): Promise<{ close: () => Promise<void>; port: number }> {
  const server: Server = createServer((req, res) => {
    middleware(req, res as never, () => {
      res.statusCode = 404;
      res.end("Not Found");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

describe("topik integration", () => {
  let tempDir: string;
  let dir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "topik-astro-integration-"));
    dir = join(tempDir, "content");
    await mkdir(dir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("delivers only compiler-proven Guide image and download payloads", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "manual.pdf"), PDF_BYTES);
    await writeFile(
      join(dir, "intro.md"),
      "# Intro\n\n![Hero](hero.png)\n\n[Manual](manual.pdf)\n",
    );
    const loader = topikGuidesLoader({ dir, sourceNamespace: "astro-guide-delivery" });
    const context = createMockContext();
    await loader.load(context);
    const middleware = createMiddleware([loader]);

    expect(context.entries.get("guides-intro")?.body).toMatch(/asset:auto-v1-[a-z2-7]{51}[aq]/u);
    const expectedBytes = new Map([
      ["image/png", PNG_BYTES],
      ["application/pdf", PDF_BYTES],
    ]);
    for (const asset of loader.getAssets()) {
      const delivered = await dispatch(middleware, `/${asset.spec.uri}`);
      expect(delivered.next).not.toHaveBeenCalled();
      expect(delivered.response.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        asset.spec.mediaType,
      );
      expect(delivered.response.setHeader).toHaveBeenCalledWith(
        "X-Content-Type-Options",
        "nosniff",
      );
      expect(delivered.response.end).toHaveBeenCalledWith(expectedBytes.get(asset.spec.mediaType));
      expect(loader.resolveAsset(asset.name)).toBe(`/${asset.spec.uri}`);
    }
  });

  test("admits only literal raw development blob request targets", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](hero.png)\n");
    const loader = topikGuidesLoader({ dir, sourceNamespace: "astro-raw-delivery" });
    await loader.load(createMockContext());
    const asset = loader.getAssets()[0];
    const canonicalPath = `/${asset.spec.uri}`;
    const digest = asset.spec.uri.slice("blobs/".length);
    const encodedDigest = `%${digest.charCodeAt(0).toString(16).padStart(2, "0")}${digest.slice(1)}`;
    const running = await startRawDevelopmentServer(createMiddleware([loader]));
    try {
      const paths = [
        canonicalPath,
        `${canonicalPath}?cache=off`,
        `/blobs/../blobs/${digest}`,
        `/blobs/%2e%2e/blobs/${digest}`,
        `/blobs/..\\blobs/${digest}`,
        `/blobs/%5c${digest}`,
        `/blobs/${encodedDigest}`,
        `/assets/sha256/${digest}`,
      ] as const;
      const statuses = Object.fromEntries(
        await Promise.all(
          paths.map(async (path) => {
            const [get, head] = await Promise.all(
              (["GET", "HEAD"] as const).map((method) =>
                requestRawDevelopmentServer(running.port, path, method),
              ),
            );
            return [
              path,
              { GET: get.status, HEAD: head.status, getBody: get.body, headBody: head.body },
            ] as const;
          }),
        ),
      );

      for (const path of [canonicalPath, `${canonicalPath}?cache=off`]) {
        expect(statuses[path]).toEqual({
          GET: 200,
          HEAD: 200,
          getBody: PNG_BYTES,
          headBody: Buffer.alloc(0),
        });
      }
      expect(
        Object.fromEntries(
          paths
            .slice(2)
            .map((path) => [path, { GET: statuses[path].GET, HEAD: statuses[path].HEAD }]),
        ),
      ).toEqual(Object.fromEntries(paths.slice(2).map((path) => [path, { GET: 404, HEAD: 404 }])));
    } finally {
      await running.close();
    }
  });

  test("delivers only compiler-proven Wiki image and download payloads", async () => {
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "manual.pdf"), PDF_BYTES);
    await writeFile(
      join(dir, "intro.md"),
      "# Intro\n\n![Hero](hero.png)\n\n[Manual](manual.pdf)\n",
    );
    const loader = topikWikiLoader({ dir, sourceNamespace: "astro-wiki-delivery" });
    const context = createMockContext();
    await loader.load(context);
    const middleware = createMiddleware([loader]);

    expect([...context.entries.values()][0]?.body).toMatch(/asset:auto-v1-[a-z2-7]{51}[aq]/u);
    const expectedBytes = new Map([
      ["image/png", PNG_BYTES],
      ["application/pdf", PDF_BYTES],
    ]);
    for (const asset of loader.getAssets()) {
      const delivered = await dispatch(middleware, `/${asset.spec.uri}`);
      expect(delivered.next).not.toHaveBeenCalled();
      expect(delivered.response.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        asset.spec.mediaType,
      );
      expect(delivered.response.end).toHaveBeenCalledWith(expectedBytes.get(asset.spec.mediaType));
      expect(loader.resolveAsset(asset.name)).toBe(`/${asset.spec.uri}`);
    }
  });

  test("never serves unreferenced raw files or unsafe source-path forms", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\nNo Assets.\n");
    await writeFile(join(dir, "unreferenced.png"), PNG_BYTES);
    await writeFile(join(dir, "spoofed.png"), "not image bytes");
    await writeFile(join(dir, "active.svg"), '<svg onload="alert(1)" />');
    await writeFile(
      join(dir, "pointer.png"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1\n`,
    );
    await writeFile(join(dir, ".gitattributes"), "filtered.png filter=custom\n");
    await writeFile(join(dir, "filtered.png"), PNG_BYTES);
    await writeFile(join(dir, "executable.png"), PNG_BYTES);
    await chmod(join(dir, "executable.png"), 0o755);
    await execFileAsync("mkfifo", [join(dir, "special.png")]);
    const sharedDir = join(dir, "shared");
    await mkdir(sharedDir);
    await writeFile(join(sharedDir, "linked.png"), PNG_BYTES);
    await symlink(sharedDir, join(dir, "images"), "dir");
    const loader = topikGuidesLoader({ dir, sourceNamespace: "astro-unreferenced-files" });
    await loader.load(createMockContext());
    const middleware = createMiddleware([loader]);

    expect(loader.getAssets()).toEqual([]);

    for (const url of [
      "/unreferenced.png",
      "/spoofed.png",
      "/active.svg",
      "/pointer.png",
      "/filtered.png",
      "/executable.png",
      "/special.png",
      "/images/linked.png",
    ]) {
      const result = await dispatch(middleware, url);
      expect(result.next).toHaveBeenCalledTimes(1);
      expect(result.response.end).not.toHaveBeenCalled();
    }
  });

  test("advances atomically between compiler snapshots without serving mutated source paths", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](hero.png)\n");
    const loader = topikGuidesLoader({ dir, sourceNamespace: "astro-snapshot-mutation" });
    const context = createMockContext();
    await loader.load(context);
    const middleware = createMiddleware([loader]);
    const firstAsset = loader.getAssets()[0];
    const firstUrl = `/${firstAsset.spec.uri}`;
    const changedBytes = Buffer.concat([PNG_BYTES, Buffer.from([0])]);

    await writeFile(join(dir, "hero.png"), changedBytes);
    const beforeReload = await dispatch(middleware, firstUrl);
    expect(beforeReload.response.end).toHaveBeenCalledWith(PNG_BYTES);
    expect((await dispatch(middleware, "/hero.png")).next).toHaveBeenCalledTimes(1);

    await loader.load(context);
    const changedAsset = loader.getAssets()[0];
    expect(changedAsset.name).toBe(firstAsset.name);
    expect(changedAsset.spec.uri).not.toBe(firstAsset.spec.uri);
    expect((await dispatch(middleware, firstUrl)).next).toHaveBeenCalledTimes(1);
    expect(
      (await dispatch(middleware, `/${changedAsset.spec.uri}`)).response.end,
    ).toHaveBeenCalledWith(changedBytes);
  });

  test("clears the prior snapshot before a failed unsafe-source recompilation", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](hero.png)\n");
    const loader = topikGuidesLoader({ dir, sourceNamespace: "astro-failed-snapshot" });
    const context = createMockContext();
    await loader.load(context);
    const middleware = createMiddleware([loader]);
    const priorUrl = `/${loader.getAssets()[0].spec.uri}`;
    await writeFile(join(dir, "active.svg"), '<svg onload="alert(1)" />');
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Active](active.svg)\n");

    await expect(loader.load(context)).rejects.toBeDefined();

    expect(loader.getAssets()).toEqual([]);
    expect((await dispatch(middleware, priorUrl)).next).toHaveBeenCalledTimes(1);
    expect((await dispatch(middleware, "/active.svg")).next).toHaveBeenCalledTimes(1);
  });

  test("falls through for non-Asset routes and non-GET requests", async () => {
    const middleware = createMiddleware([]);
    expect((await dispatch(middleware, "/docs/getting-started")).next).toHaveBeenCalledTimes(1);
    expect(
      (await dispatch(middleware, `/assets/sha256/${"a".repeat(64)}`)).next,
    ).toHaveBeenCalledTimes(1);
    expect(
      (await dispatch(middleware, `/blobs/${"a".repeat(64)}`, "POST")).next,
    ).toHaveBeenCalledTimes(1);
  });

  test("never follows a displaced static Asset parent during build cleanup", async () => {
    const output = join(tempDir, "dist");
    const outsider = join(tempDir, "outsider");
    const codegen = join(tempDir, "codegen");
    await mkdir(output);
    await mkdir(outsider, { recursive: true });
    await mkdir(codegen);
    await writeFile(join(outsider, "author.txt"), "preserve me");
    await symlink(outsider, join(output, "blobs"), "dir");

    const integration = topik({ loaders: [] });
    await expect(
      integration.hooks["astro:config:setup"]?.({
        addMiddleware: () => undefined,
        command: "build",
        config: { outDir: pathToFileURL(`${output}/`), output: "static" },
        createCodegenDir: () => pathToFileURL(`${codegen}/`),
        updateConfig: () => undefined,
      } as never),
    ).rejects.toBeDefined();

    expect(await readFile(join(outsider, "author.txt"), "utf8")).toBe("preserve me");
  });
});

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { compile, replaceCompilationTree } from "./index";
import { formatPublicCliError } from "../errors";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const execFileAsync = promisify(execFile);

type CompileCommand = {
  handler?: (options: {
    dir: string;
    outDir?: string;
    format: "json";
    dryRun: boolean;
    validate: boolean;
    links: "error" | "warning" | "off";
    sourceNamespace?: string;
  }) => Promise<void>;
};

describe("compile command", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-compile-"));
    await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  test("reports resources and payloads deterministically in dry-run mode", async () => {
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](hero.png)\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await (compile as CompileCommand).handler?.({
      dir,
      format: "json",
      dryRun: true,
      validate: true,
      links: "error",
      sourceNamespace: "cli-test-source",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^Asset\/auto-v1-[a-z2-7]{51}[aq]\.json$/u),
    );
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^assets\/sha256\/[0-9a-f]{64}$/u));
  });

  test("never exposes absolute Guide or WikiPage paths in CLI compile failures", async () => {
    await writeFile(join(dir, "intro.md"), "<http://example.com/guide.pdf>\n");
    await writeFile(join(dir, "wiki.yaml"), "id: wiki\ntitle: Wiki\nnavigation:\n  - unsafe\n");
    await writeFile(join(dir, "unsafe.md"), "<http://example.com/wiki.pdf>\n");

    let failure: unknown;
    try {
      await (compile as CompileCommand).handler?.({
        dir,
        format: "json",
        dryRun: true,
        validate: true,
        links: "error",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ file: "intro.md" }),
        expect.objectContaining({ file: "unsafe.md" }),
      ]),
    });
    expect(`${String(failure)}\n${JSON.stringify(failure)}`).not.toContain(dir);
    expect(`${String(failure)}\n${JSON.stringify(failure)}`).not.toContain(tmpdir());
  });

  test("keeps invalid config bytes and machine paths out of CLI compile error output", async () => {
    const sentinel = "PRIVATE_VALUE";
    await writeFile(join(dir, "wiki.yaml"), `id: docs\ntitle: [${sentinel}\n`);

    let failure: unknown;
    try {
      await (compile as CompileCommand).handler?.({
        dir,
        format: "json",
        dryRun: true,
        validate: true,
        links: "error",
        sourceNamespace: "cli-test-source",
      });
    } catch (error) {
      failure = error;
    }
    const output = formatPublicCliError(failure);
    const surfaces = [
      output,
      String(failure),
      failure instanceof Error ? failure.message : "",
      JSON.stringify(failure),
      typeof failure === "object" && failure !== null ? JSON.stringify(Object.values(failure)) : "",
      failure instanceof Error && failure.cause instanceof Error ? String(failure.cause) : "",
    ].join("\n");
    expect(output).toBe("Configuration file could not be parsed.");
    expect(surfaces).not.toContain(sentinel);
    expect(surfaces).not.toContain(dir);
    expect(surfaces).not.toContain(tmpdir());
  });

  test("uses the same generated identity for canonically equivalent CLI namespaces", async () => {
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "intro.md"), "![Hero](hero.png)\n");
    const names: string[] = [];
    for (const [suffix, sourceNamespace] of [
      ["composed", "é"],
      ["decomposed", "e\u0301"],
    ] as const) {
      const outDir = join(dir, `out-${suffix}`);
      await (compile as CompileCommand).handler?.({
        dir,
        outDir,
        format: "json",
        dryRun: false,
        validate: true,
        links: "error",
        sourceNamespace,
      });
      names.push((await readdir(join(outDir, "Asset")))[0]);
    }
    expect(names[0]).toBe(names[1]);
  });

  test("writes one complete deterministic tree and prunes stale files", async () => {
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](hero.png)\n");
    const outDir = join(dir, "compiled");
    const options = {
      dir,
      outDir,
      format: "json" as const,
      dryRun: false,
      validate: true,
      links: "error" as const,
      sourceNamespace: "cli-test-source",
    };
    await (compile as CompileCommand).handler?.(options);
    expect((await lstat(outDir)).isDirectory()).toBe(true);
    const [assetFile] = await readdir(join(outDir, "Asset"));
    const descriptor = await readFile(join(outDir, "Asset", assetFile), "utf8");
    const asset = JSON.parse(descriptor) as { spec: { uri: string } };
    expect(await readFile(join(outDir, asset.spec.uri))).toEqual(PNG_BYTES);
    const firstIdentity = await readFile(join(outDir, ".topik", "materialization.json"));
    const materialization = JSON.parse(firstIdentity.toString("utf8")) as {
      resources: Array<{ resource: string; path: string; size: number; sha256: string }>;
      payloads: Array<{ path: string; size: number; sha256: string }>;
    };
    for (const record of materialization.resources) {
      const bytes = await readFile(join(outDir, record.path));
      const descriptor = JSON.parse(bytes.toString("utf8")) as { type: string; name: string };
      expect(`${descriptor.type}/${descriptor.name}`).toBe(record.resource);
      expect(bytes.byteLength).toBe(record.size);
      expect(sha256(bytes)).toBe(record.sha256);
      expect(record.path).toBe(`${record.resource}.json`);
    }
    for (const record of materialization.payloads) {
      const bytes = await readFile(join(outDir, record.path));
      expect(bytes.byteLength).toBe(record.size);
      expect(sha256(bytes)).toBe(record.sha256);
    }
    const recordedOutput = [
      ...materialization.resources.map((record) => record.path),
      ...materialization.payloads.map((record) => record.path),
    ].sort();
    const actualOutput = (await listFiles(outDir))
      .filter((path) => !path.startsWith(".topik/"))
      .sort();
    expect(actualOutput).toEqual(recordedOutput);
    await writeFile(join(outDir, "stale.bin"), "stale");
    await (compile as CompileCommand).handler?.(options);
    expect((await lstat(outDir)).isDirectory()).toBe(true);
    expect(await readFile(join(outDir, ".topik", "materialization.json"))).toEqual(firstIdentity);
    await expect(readFile(join(outDir, "stale.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(dir)).filter(
        (name) =>
          name.startsWith(".topik-compilation-generation-") ||
          name.startsWith(".topik-compilation-prior-"),
      ),
    ).toEqual([]);
  });

  test("rejects a symlinked output ancestor without writing outside", async () => {
    const outside = await mkdtemp(join(tmpdir(), "topik-cli-outside-"));
    await symlink(outside, join(dir, "output-link"), "dir");
    await expect(
      (compile as CompileCommand).handler?.({
        dir,
        outDir: join(dir, "output-link", "compiled"),
        format: "json",
        dryRun: false,
        validate: true,
        links: "error",
      }),
    ).rejects.toThrow(/link or non-directory collision/u);
    expect(await readdir(outside)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  test("rejects hard-linked existing output without changing its peer", async () => {
    const outDir = join(dir, "compiled");
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "outside");
    await mkdir(outDir);
    await writeOwnedTree(outDir, "existing");
    await link(outside, join(outDir, "collision.txt"));
    await expect(
      (compile as CompileCommand).handler?.({
        dir,
        outDir,
        format: "json",
        dryRun: false,
        validate: true,
        links: "error",
      }),
    ).rejects.toThrow(/hard link/u);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  test("rejects source and source-ancestor output roots without mutation", async () => {
    const originalConfig = await readFile(join(dir, "collection.yaml"));
    const originalGuide = await readFile(join(dir, "intro.md"));
    for (const outDir of [dir, dirname(dir)]) {
      await expect(
        (compile as CompileCommand).handler?.({
          dir,
          outDir,
          format: "json",
          dryRun: false,
          validate: true,
          links: "error",
        }),
      ).rejects.toThrow(/cannot equal or contain the source/u);
      expect(await readFile(join(dir, "collection.yaml"))).toEqual(originalConfig);
      expect(await readFile(join(dir, "intro.md"))).toEqual(originalGuide);
    }
  });

  test("rejects a source ancestor reached through an alternate symlink spelling", async () => {
    const realSource = join(dir, "source");
    const aliasRoot = await mkdtemp(join(tmpdir(), "topik-cli-source-alias-"));
    const sourceAlias = join(aliasRoot, "source");
    await mkdir(realSource);
    await writeFile(join(realSource, "collection.yaml"), "id: linked\ntitle: Linked\n");
    await writeFile(join(realSource, "intro.md"), "# Linked\n");
    await symlink(realSource, sourceAlias, "dir");
    try {
      await expect(
        (compile as CompileCommand).handler?.({
          dir: sourceAlias,
          outDir: dir,
          format: "json",
          dryRun: false,
          validate: true,
          links: "error",
        }),
      ).rejects.toThrow(/cannot equal or contain the source/u);
      expect(await readFile(join(realSource, "intro.md"), "utf8")).toBe("# Linked\n");
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  test("refuses a populated unowned output directory without mutation", async () => {
    const outDir = join(dir, "unowned");
    await mkdir(outDir);
    await writeFile(join(outDir, "author.txt"), "keep me");
    await expect(
      (compile as CompileCommand).handler?.({
        dir,
        outDir,
        format: "json",
        dryRun: false,
        validate: true,
        links: "error",
      }),
    ).rejects.toThrow(/not recognized as owned/u);
    expect(await readFile(join(outDir, "author.txt"), "utf8")).toBe("keep me");
  });

  test("refuses a symlinked output without touching its target", async () => {
    const outDir = join(dir, "unowned-pointer");
    const outside = await mkdtemp(join(tmpdir(), "topik-cli-unowned-pointer-"));
    await writeFile(join(outside, "author.txt"), "keep me");
    await symlink(outside, outDir, "dir");
    try {
      await expect(
        (compile as CompileCommand).handler?.({
          dir,
          outDir,
          format: "json",
          dryRun: false,
          validate: true,
          links: "error",
        }),
      ).rejects.toThrow(/link or non-directory collision/u);
      expect(await readFile(join(outside, "author.txt"), "utf8")).toBe("keep me");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("replaces an existing owned directory and removes its stale files", async () => {
    const outDir = join(dir, "directory-output");
    await mkdir(join(outDir, ".topik"), { recursive: true });
    for (const file of ownedFiles("existing")) {
      await mkdir(dirname(join(outDir, file.path)), { recursive: true });
      await writeFile(join(outDir, file.path), file.bytes);
    }

    await replaceCompilationTree(outDir, ownedFiles("new"));
    expect((await lstat(outDir)).isDirectory()).toBe(true);
    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("new");
  });

  test("rejects an invalid staged file set before publishing any generation", async () => {
    const outDir = join(dir, "invalid-staging");
    await expect(
      replaceCompilationTree(outDir, [
        { path: "duplicate.txt", bytes: "first" },
        { path: "duplicate.txt", bytes: "second" },
      ]),
    ).rejects.toThrow(/repeats a staged file path/u);
    await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["FIFO", ".topik/materialization.json"],
    ["FIFO", ".topik/semantic.json"],
    ["Unix socket", ".topik/materialization.json"],
    ["Unix socket", ".topik/semantic.json"],
  ] as const)(
    "promptly rejects a %s ownership marker at %s without mutation",
    async (nodeKind, marker) => {
      const markerRoot = join(dir, "m");
      const outDir = join(markerRoot, "o");
      const outside = join(markerRoot, "x");
      await mkdir(markerRoot);
      await writeFile(outside, "unchanged");
      await writeOwnedTree(outDir, "existing");
      const markerPath = join(outDir, marker);
      expect(Buffer.byteLength(markerPath)).toBeLessThan(100);
      await rm(markerPath);

      let server: Server | undefined;
      if (nodeKind === "FIFO") {
        await execFileAsync("mkfifo", [markerPath]);
      } else {
        server = createServer();
        await new Promise<void>((resolve, reject) => {
          server?.once("error", reject);
          server?.listen(markerPath, resolve);
        });
      }

      try {
        const beforeFiles = await listFiles(outDir);
        const outcome = await replaceCompilationTreeBounded(outDir, markerPath);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.result).toBe("rejected");
        expect(outcome.error).toBeInstanceOf(Error);
        expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("existing");
        expect(await listFiles(outDir)).toEqual(beforeFiles);
        expect(await readFile(outside, "utf8")).toBe("unchanged");
        expect(
          (await readdir(markerRoot)).filter(
            (name) =>
              name.startsWith(".topik-compilation-generation-") ||
              name.startsWith(".topik-compilation-prior-"),
          ),
        ).toEqual([]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          if (server === undefined) {
            resolve();
            return;
          }
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      }
    },
  );

  test("publishes without external commands when PATH has no move implementation", async () => {
    const outDir = join(dir, "node-only-publication");
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await replaceCompilationTree(outDir, ownedFiles("old"));
      await replaceCompilationTree(outDir, ownedFiles("new"));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("new");
  });
});

function ownedFiles(generation: string): Array<{ path: string; bytes: string }> {
  const payload = `payload-${generation}`;
  const payloadDigest = sha256(Buffer.from(payload));
  return [
    { path: "generation.txt", bytes: generation },
    {
      path: ".topik/materialization.json",
      bytes: `${JSON.stringify({
        descriptor: "topik-materialization-v1",
        payloads: [
          {
            assetNames: [],
            path: `assets/sha256/${payloadDigest}`,
            sha256: payloadDigest,
            size: Buffer.byteLength(payload),
          },
        ],
        resources: [],
      })}\n`,
    },
    {
      path: ".topik/semantic.json",
      bytes: '{"assetNames":[],"descriptor":"topik-asset-semantic-v1","references":[]}\n',
    },
    { path: `assets/sha256/${payloadDigest}`, bytes: payload },
  ];
}

async function writeOwnedTree(root: string, generation: string): Promise<void> {
  for (const file of ownedFiles(generation)) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.bytes);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else files.push(path);
  }
  return files;
}

async function replaceCompilationTreeBounded(
  outDir: string,
  fifoPath: string,
): Promise<{ error?: unknown; result: "resolved" | "rejected"; timedOut: boolean }> {
  const operation = replaceCompilationTree(outDir, ownedFiles("replacement")).then(
    () => ({ result: "resolved" as const }),
    (error: unknown) => ({ error, result: "rejected" as const }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    operation,
    new Promise<{ result: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ result: "timeout" }), 750);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (first.result !== "timeout") return { ...first, timedOut: false };

  // Release a blocking FIFO reader so a broken implementation cannot leave the test process hung.
  const descriptor = await open(fifoPath, constants.O_RDWR | constants.O_NONBLOCK).catch(
    () => undefined,
  );
  await descriptor?.close();
  const settled = await operation;
  return { ...settled, timedOut: true };
}

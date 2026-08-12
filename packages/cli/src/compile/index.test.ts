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
import { serializeTopikJson } from "@topik/core";
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

const invalidOwnedTreeCases: readonly (readonly [string, (root: string) => Promise<void>])[] = [
  [
    "a duplicate materialization member",
    async (root) => {
      const path = join(root, "materialization.json");
      const canonical = await readFile(path, "utf8");
      await writeFile(
        path,
        canonical.replace(
          '{\n  "descriptor":',
          '{\n  "descriptor": "topik-materialization-v1",\n  "descriptor":',
        ),
      );
    },
  ],
  [
    "noncanonical semantic bytes",
    async (root) => {
      const path = join(root, "semantic.json");
      await writeFile(path, JSON.stringify(JSON.parse(await readFile(path, "utf8"))));
    },
  ],
  [
    "an extra materialization field",
    async (root) => {
      const path = join(root, "materialization.json");
      const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      record.unexpected = true;
      await writeFile(path, serializeTopikJson(record));
    },
  ],
  [
    "a malformed materialization entry",
    async (root) => {
      const path = join(root, "materialization.json");
      const record = JSON.parse(await readFile(path, "utf8")) as { resources: unknown[] };
      record.resources[0] = null;
      await writeFile(path, serializeTopikJson(record));
    },
  ],
  [
    "a malformed semantic entry",
    async (root) => {
      const path = join(root, "semantic.json");
      const record = JSON.parse(await readFile(path, "utf8")) as { references: unknown[] };
      record.references = [null];
      await writeFile(path, serializeTopikJson(record));
    },
  ],
  [
    "a contradictory resource digest",
    async (root) => {
      const path = join(root, "materialization.json");
      const record = JSON.parse(await readFile(path, "utf8")) as {
        resources: Array<{ sha256: string }>;
      };
      record.resources[0].sha256 = "0".repeat(64);
      await writeFile(path, serializeTopikJson(record));
    },
  ],
  [
    "an orphan payload inventory entry",
    async (root) => {
      const path = join(root, "materialization.json");
      const record = JSON.parse(await readFile(path, "utf8")) as {
        payloads: unknown[];
      };
      record.payloads.push({
        assetNames: [],
        path: `blobs/${"0".repeat(64)}`,
        sha256: "0".repeat(64),
        size: 0,
      });
      await writeFile(path, serializeTopikJson(record));
    },
  ],
  [
    "an orphan semantic Asset name",
    async (root) => {
      const path = join(root, "semantic.json");
      const record = JSON.parse(await readFile(path, "utf8")) as { assetNames: string[] };
      record.assetNames.push(`auto-v1-${"a".repeat(52)}`);
      await writeFile(path, serializeTopikJson(record));
    },
  ],
  [
    "a missing resources directory",
    async (root) => rm(join(root, "resources"), { recursive: true }),
  ],
  ["a missing blobs directory", async (root) => rm(join(root, "blobs"), { recursive: true })],
  ["an unexpected file", async (root) => writeFile(join(root, "unexpected.txt"), "keep")],
  ["an unexpected directory", async (root) => mkdir(join(root, "unexpected"))],
];

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
      expect.stringMatching(/^resources\/Asset\/auto-v1-[a-z2-7]{51}[aq]\.json$/u),
    );
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^blobs\/[0-9a-f]{64}$/u));
    expect(log).toHaveBeenCalledWith("materialization.json");
    expect(log).toHaveBeenCalledWith("semantic.json");
    expect(log.mock.calls.map(([value]) => String(value)).join("\n")).not.toContain(
      "assets/sha256",
    );
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
      names.push((await readdir(join(outDir, "resources", "Asset")))[0]);
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
    expect((await readdir(outDir)).sort()).toEqual([
      "blobs",
      "materialization.json",
      "resources",
      "semantic.json",
    ]);
    const [assetFile] = await readdir(join(outDir, "resources", "Asset"));
    const descriptor = await readFile(join(outDir, "resources", "Asset", assetFile), "utf8");
    const asset = JSON.parse(descriptor) as { spec: { uri: string } };
    expect(await readFile(join(outDir, asset.spec.uri))).toEqual(PNG_BYTES);
    const firstIdentity = await readFile(join(outDir, "materialization.json"));
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
      expect(record.path).toBe(`resources/${record.resource}.json`);
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
      .filter((path) => path !== "materialization.json" && path !== "semantic.json")
      .sort();
    expect(actualOutput).toEqual(recordedOutput);

    await (compile as CompileCommand).handler?.(options);
    expect((await lstat(outDir)).isDirectory()).toBe(true);
    expect(await readFile(join(outDir, "materialization.json"))).toEqual(firstIdentity);

    await writeFile(join(dir, "intro.md"), "# Intro\n\nThe Asset was removed.\n");
    await (compile as CompileCommand).handler?.(options);
    const replacementMaterialization = JSON.parse(
      await readFile(join(outDir, "materialization.json"), "utf8"),
    ) as {
      resources: Array<{ path: string }>;
      payloads: Array<{ path: string }>;
    };
    const replacementOutput = new Set([
      ...replacementMaterialization.resources.map((record) => record.path),
      ...replacementMaterialization.payloads.map((record) => record.path),
    ]);
    const prunedPaths = recordedOutput.filter((path) => !replacementOutput.has(path));
    expect(prunedPaths.length).toBeGreaterThan(0);
    for (const path of prunedPaths) {
      await expect(readFile(join(outDir, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(
      (await readdir(dir)).filter(
        (name) =>
          name.startsWith(".topik-compilation-generation-") ||
          name.startsWith(".topik-compilation-prior-"),
      ),
    ).toEqual([]);
  });

  test("uses .topik as the default compilation root without rediscovering prior output", async () => {
    const options = {
      dir,
      format: "json" as const,
      dryRun: false,
      validate: true,
      links: "error" as const,
      sourceNamespace: "cli-default-output",
    };
    await (compile as CompileCommand).handler?.(options);
    const outDir = join(dir, ".topik");
    const firstTree = await snapshotTree(outDir);
    expect((await readdir(outDir)).sort()).toEqual([
      "blobs",
      "materialization.json",
      "resources",
      "semantic.json",
    ]);
    expect(await readdir(join(outDir, "blobs"))).toEqual([]);
    expect(await readdir(join(outDir, "resources", "Guide"))).toEqual(["docs-intro.json"]);

    await (compile as CompileCommand).handler?.(options);
    expect(await snapshotTree(outDir)).toEqual(firstTree);
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
    await writeOwnedTree(outDir, "existing");

    await replaceCompilationTree(outDir, ownedFiles("new"));
    expect((await lstat(outDir)).isDirectory()).toBe(true);
    await expectOwnedGeneration(outDir, "new");
    await expect(readFile(join(outDir, ownedResourcePath("existing")))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test.each(["blobs", "resources"] as const)(
    "requires the empty %s directory in an otherwise valid empty prior compilation",
    async (missingDirectory) => {
      const outDir = join(dir, `missing-empty-${missingDirectory}`);
      await writeEmptyOwnedTree(outDir);
      await rm(join(outDir, missingDirectory), { recursive: true });
      const before = await snapshotTree(outDir);

      await expect(replaceCompilationTree(outDir, ownedFiles("replacement"))).rejects.toThrow(
        /not recognized as owned/u,
      );
      expect(await snapshotTree(outDir)).toEqual(before);
    },
  );

  test("replaces a genuinely valid empty prior compilation", async () => {
    const outDir = join(dir, "valid-empty-compilation");
    await writeEmptyOwnedTree(outDir);

    await replaceCompilationTree(outDir, ownedFiles("replacement"));
    await expectOwnedGeneration(outDir, "replacement");
  });

  test.each(
    (
      [
        { treeKind: "empty", writeTree: writeEmptyOwnedTree },
        {
          treeKind: "populated",
          writeTree: async (root: string) => writeOwnedTree(root, "existing"),
        },
      ] as const
    ).flatMap(({ treeKind, writeTree }) =>
      (["materialization.json", "semantic.json"] as const).map((marker) => ({
        marker,
        treeKind,
        writeTree,
      })),
    ),
  )(
    "rejects and preserves a $treeKind prior compilation with a BOM-prefixed $marker",
    async ({ treeKind, writeTree, marker }) => {
      const outDir = join(dir, `bom-${treeKind}-${marker}`);
      await writeTree(outDir);
      const markerPath = join(outDir, marker);
      await writeFile(
        markerPath,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(markerPath)]),
      );
      const before = await snapshotTree(outDir);

      const outcome = await replaceCompilationTreePromptly(outDir);

      expect(outcome).toEqual({ result: "rejected", timedOut: false });
      expect(await snapshotTree(outDir)).toEqual(before);
      expect(
        (await readdir(dir)).filter(
          (name) =>
            name.startsWith(".topik-compilation-generation-") ||
            name.startsWith(".topik-compilation-prior-"),
        ),
      ).toEqual([]);
    },
  );

  test.each(invalidOwnedTreeCases)(
    "rejects and preserves an owned-looking tree with %s",
    async (_label, invalidate) => {
      const outDir = join(dir, "invalid-owned-tree");
      await writeOwnedTree(outDir, "existing");
      await invalidate(outDir);
      const before = await snapshotTree(outDir);

      const result = await replaceCompilationTree(outDir, ownedFiles("replacement")).then(
        () => "resolved" as const,
        () => "rejected" as const,
      );

      expect({ preserved: await snapshotTree(outDir), result }).toEqual({
        preserved: before,
        result: "rejected",
      });
      expect(
        (await readdir(dir)).filter(
          (name) =>
            name.startsWith(".topik-compilation-generation-") ||
            name.startsWith(".topik-compilation-prior-"),
        ),
      ).toEqual([]);
    },
  );

  test("rejects a nested symlink in an owned-looking tree without touching its target", async () => {
    const outDir = join(dir, "symlinked-owned-tree");
    const outside = join(dir, "outside-owned-tree.txt");
    await writeOwnedTree(outDir, "existing");
    await writeFile(outside, "unchanged");
    const linkPath = join(outDir, "resources", "linked.txt");
    await symlink(outside, linkPath);

    await expect(replaceCompilationTree(outDir, ownedFiles("replacement"))).rejects.toThrow(
      /link or special-node/u,
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("unchanged");
    await expectOwnedGeneration(outDir, "existing");
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
    ["FIFO", "materialization.json"],
    ["FIFO", "semantic.json"],
    ["Unix socket", "materialization.json"],
    ["Unix socket", "semantic.json"],
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
        await expectOwnedGeneration(outDir, "existing");
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
    await expectOwnedGeneration(outDir, "new");
  });
});

function ownedFiles(generation: string): Array<{ path: string; bytes: string }> {
  const resource = {
    apiVersion: "v1",
    name: `guide-${generation}`,
    spec: {
      content: { format: "topik", value: `# ${generation}\n` },
      slug: `guide-${generation}`,
      title: generation,
    },
    type: "Guide",
  };
  const resourceBytes = serializeTopikJson(resource);
  return [
    { path: ownedResourcePath(generation), bytes: resourceBytes },
    {
      path: "materialization.json",
      bytes: serializeTopikJson({
        descriptor: "topik-materialization-v1",
        payloads: [],
        resources: [
          {
            path: ownedResourcePath(generation),
            resource: `Guide/guide-${generation}`,
            sha256: sha256(Buffer.from(resourceBytes)),
            size: Buffer.byteLength(resourceBytes),
          },
        ],
      }),
    },
    {
      path: "semantic.json",
      bytes: serializeTopikJson({
        assetNames: [],
        descriptor: "topik-asset-semantic-v1",
        references: [],
      }),
    },
  ];
}

async function writeOwnedTree(root: string, generation: string): Promise<void> {
  await mkdir(join(root, "blobs"), { recursive: true });
  await mkdir(join(root, "resources"), { recursive: true });
  for (const file of ownedFiles(generation)) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.bytes);
  }
}

async function writeEmptyOwnedTree(root: string): Promise<void> {
  await mkdir(join(root, "blobs"), { recursive: true });
  await mkdir(join(root, "resources"), { recursive: true });
  for (const file of [
    {
      path: "materialization.json",
      bytes: serializeTopikJson({
        descriptor: "topik-materialization-v1",
        payloads: [],
        resources: [],
      }),
    },
    {
      path: "semantic.json",
      bytes: serializeTopikJson({
        assetNames: [],
        descriptor: "topik-asset-semantic-v1",
        references: [],
      }),
    },
  ]) {
    await writeFile(join(root, file.path), file.bytes);
  }
}

function ownedResourcePath(generation: string): string {
  return `resources/Guide/guide-${generation}.json`;
}

async function expectOwnedGeneration(root: string, generation: string): Promise<void> {
  const resource = JSON.parse(
    await readFile(join(root, ownedResourcePath(generation)), "utf8"),
  ) as { name: string };
  expect(resource.name).toBe(`guide-${generation}`);
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

async function snapshotTree(root: string, prefix = ""): Promise<Array<[string, string]>> {
  const snapshot: Array<[string, string]> = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      snapshot.push([`${path}/`, "directory"]);
      snapshot.push(...(await snapshotTree(root, path)));
    } else {
      snapshot.push([path, sha256(await readFile(join(root, path)))]);
    }
  }
  return snapshot.sort(([left], [right]) => left.localeCompare(right));
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

async function replaceCompilationTreePromptly(
  outDir: string,
): Promise<{ result: "rejected" | "resolved" | "timeout"; timedOut: boolean }> {
  const operation = replaceCompilationTree(outDir, ownedFiles("replacement")).then(
    () => ({ result: "resolved" as const, timedOut: false }),
    () => ({ result: "rejected" as const, timedOut: false }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    operation,
    new Promise<{ result: "timeout"; timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ result: "timeout", timedOut: true }), 750);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { compile, replaceCompilationTree } from "./index";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

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
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Asset\/auto-v1-[a-z2-7]{52}\.json$/u));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^assets\/sha256\/[0-9a-f]{64}$/u));
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

  test("atomically writes one self-contained retry-stable tree and prunes stale files", async () => {
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
    expect((await lstat(outDir)).isSymbolicLink()).toBe(true);
    const firstGeneration = await readlink(outDir);
    expect(firstGeneration).toMatch(/^\.topik-compilation-generation-/u);
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
    const secondGeneration = await readlink(outDir);
    expect(secondGeneration).not.toBe(firstGeneration);
    expect(await readFile(join(outDir, ".topik", "materialization.json"))).toEqual(firstIdentity);
    await expect(readFile(join(outDir, "stale.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(dir, firstGeneration))).isDirectory()).toBe(true);
    expect(await readFile(join(dir, firstGeneration, "stale.bin"), "utf8")).toBe("stale");
    expect(
      (await readdir(dir))
        .filter((name) => name.startsWith(".topik-compilation-generation-"))
        .sort(),
    ).toEqual([firstGeneration, secondGeneration].sort());
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

  test("refuses an unowned output pointer without touching its target", async () => {
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
      ).rejects.toThrow(/not recognized as owned/u);
      expect(await readFile(join(outside, "author.txt"), "utf8")).toBe("keep me");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("fails visibly instead of non-atomically replacing a real directory", async () => {
    const outDir = join(dir, "directory-output");
    await mkdir(join(outDir, ".topik"), { recursive: true });
    for (const file of ownedFiles("existing")) {
      await mkdir(dirname(join(outDir, file.path)), { recursive: true });
      await writeFile(join(outDir, file.path), file.bytes);
    }

    await expect(replaceCompilationTree(outDir, ownedFiles("new"))).rejects.toThrow(
      /cannot be replaced atomically/u,
    );
    expect((await lstat(outDir)).isDirectory()).toBe(true);
    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("existing");
  });

  test("publishes through one atomic pointer rename and keeps a complete generation on failures", async () => {
    const outDir = join(dir, "atomic");
    await replaceCompilationTree(outDir, ownedFiles("old"));
    const oldGeneration = await readlink(outDir);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staged: () => void = () => undefined;
    const stagedReady = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const publishing = replaceCompilationTree(outDir, ownedFiles("new"), {
      beforePublish: async () => {
        staged();
        await gate;
      },
    });
    await stagedReady;
    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("old");
    const readerFailures: string[] = [];
    let keepReading = true;
    const reader = (async () => {
      while (keepReading) {
        try {
          const generation = await readFile(join(outDir, "generation.txt"), "utf8");
          if (generation !== "old" && generation !== "new") readerFailures.push(generation);
        } catch (error) {
          readerFailures.push((error as NodeJS.ErrnoException).code ?? "read-failed");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    release();
    await publishing;
    keepReading = false;
    await reader;
    expect(readerFailures).toEqual([]);
    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("new");
    const newGeneration = await readlink(outDir);
    expect(newGeneration).not.toBe(oldGeneration);
    expect((await lstat(join(dir, oldGeneration))).isDirectory()).toBe(true);

    await expect(
      replaceCompilationTree(outDir, ownedFiles("never-visible"), {
        beforePublish: () => {
          throw new Error("interrupted before publish");
        },
      }),
    ).rejects.toThrow("interrupted before publish");
    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("new");
    expect(await readlink(outDir)).toBe(newGeneration);

    await expect(
      replaceCompilationTree(outDir, ownedFiles("published"), {
        afterPublish: () => {
          throw new Error("interrupted after publish");
        },
      }),
    ).rejects.toThrow("interrupted after publish");
    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("published");
    expect(await readlink(outDir)).not.toBe(newGeneration);
    expect((await lstat(join(dir, newGeneration))).isDirectory()).toBe(true);
  });

  test("publishes without external commands when PATH has no mv implementation", async () => {
    const outDir = join(dir, "node-only-atomic");
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

  test("retains unrelated content swapped in after publish-staging proof", async () => {
    const outDir = join(dir, "publish-staging-race");
    const displaced = join(dir, "displaced-publish-staging");
    let replacement = "";

    await replaceCompilationTree(outDir, ownedFiles("new"), {
      afterPublishStagingProof: async (path) => {
        replacement = join(dir, path.slice(path.lastIndexOf("/") + 1));
        await rename(path, displaced);
        await mkdir(path);
        await writeFile(join(path, "author.txt"), "preserve me");
      },
    });

    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("new");
    expect((await listFiles(outDir)).sort()).toEqual(
      ownedFiles("new")
        .map((file) => file.path)
        .sort(),
    );
    expect(await readFile(join(replacement, "author.txt"), "utf8")).toBe("preserve me");
    expect(await readdir(displaced)).toEqual([]);
  });

  test("retains unrelated content swapped in after failed-generation proof", async () => {
    const outDir = join(dir, "failed-generation-race");
    const displaced = join(dir, "displaced-failed-generation");
    let replacement = "";
    await replaceCompilationTree(outDir, ownedFiles("old"));

    await expect(
      replaceCompilationTree(outDir, ownedFiles("new"), {
        beforePublish: () => {
          throw new Error("stop before publish");
        },
        afterFailedGenerationProof: async (path) => {
          replacement = join(dir, path.slice(path.lastIndexOf("/") + 1));
          await rename(path, displaced);
          await mkdir(path);
          await writeFile(join(path, "author.txt"), "preserve me");
        },
      }),
    ).rejects.toThrow("stop before publish");

    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("old");
    expect((await listFiles(outDir)).sort()).toEqual(
      ownedFiles("old")
        .map((file) => file.path)
        .sort(),
    );
    expect(await readFile(join(replacement, "author.txt"), "utf8")).toBe("preserve me");
    expect(await readFile(join(displaced, "generation.txt"), "utf8")).toBe("new");
  });

  test("uses the anchored file-staging descriptor after its pathname is replaced", async () => {
    const outDir = join(dir, "file-staging-race");
    const displaced = join(dir, "displaced-file-staging");
    let replacement = "";
    await replaceCompilationTree(outDir, ownedFiles("old"));

    await replaceCompilationTree(outDir, ownedFiles("new"), {
      afterFileStagingProof: async (path) => {
        replacement = join(dir, path.slice(path.lastIndexOf("/") + 1));
        await rename(path, displaced);
        await mkdir(path);
        await writeFile(join(path, "author.txt"), "preserve me");
      },
    });

    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("new");
    expect((await listFiles(outDir)).sort()).toEqual(
      ownedFiles("new")
        .map((file) => file.path)
        .sort(),
    );
    expect(await readFile(join(replacement, "author.txt"), "utf8")).toBe("preserve me");
    expect(await readdir(displaced)).toEqual([]);
  });

  test.each([
    ["directory", "absent"],
    ["symlink", "absent"],
    ["directory", "replacement"],
    ["symlink", "replacement"],
  ] as const)(
    "never publishes a generation-path %s replacement for %s output",
    async (replacementKind, mode) => {
      const outDir = join(dir, `generation-binding-${mode}-${replacementKind}`);
      const displacedGeneration = join(
        dir,
        `displaced-intended-generation-${mode}-${replacementKind}`,
      );
      const unrelatedTarget = join(dir, `unrelated-generation-${mode}-${replacementKind}`);
      let replacementGeneration = "";
      if (mode === "replacement") await replaceCompilationTree(outDir, ownedFiles("old"));

      await expect(
        replaceCompilationTree(outDir, ownedFiles("new"), {
          afterStagedGenerationProof: async (path) => {
            replacementGeneration = join(dir, path.slice(path.lastIndexOf("/") + 1));
            await rename(path, displacedGeneration);
            if (replacementKind === "directory") {
              await mkdir(path);
              await writeOwnedTree(path, "unrelated");
            } else {
              await mkdir(unrelatedTarget);
              await writeOwnedTree(unrelatedTarget, "unrelated");
              await symlink(unrelatedTarget, path, "dir");
            }
          },
        }),
      ).rejects.toThrow(/identity changed/u);

      if (mode === "replacement") {
        expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("old");
        expect((await listFiles(outDir)).sort()).toEqual(
          ownedFiles("old")
            .map((file) => file.path)
            .sort(),
        );
      } else {
        await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readFile(join(replacementGeneration, "generation.txt"), "utf8")).toBe(
        "unrelated",
      );
      if (replacementKind === "symlink") {
        expect(await readlink(replacementGeneration)).toBe(unrelatedTarget);
      }
      expect(await readFile(join(displacedGeneration, "generation.txt"), "utf8")).toBe("new");
    },
  );

  test.each([
    ["absent", "regular"],
    ["absent", "symlink"],
    ["replacement", "regular"],
    ["replacement", "symlink"],
  ] as const)(
    "preserves a %s-output %s target inserted after the prior proof",
    async (mode, newcomerKind) => {
      const outDir = join(dir, `target-race-${mode}-${newcomerKind}`);
      const displacedOld = join(dir, `displaced-old-${mode}-${newcomerKind}`);
      const newcomerTarget = join(dir, `newcomer-target-${mode}-${newcomerKind}`);
      if (mode === "replacement") await replaceCompilationTree(outDir, ownedFiles("old"));
      if (newcomerKind === "symlink") {
        await mkdir(newcomerTarget);
        await writeFile(join(newcomerTarget, "author.txt"), "preserve me");
      }

      await expect(
        replaceCompilationTree(outDir, ownedFiles("new"), {
          afterOutputTargetProof: async (path) => {
            if (mode === "replacement") await rename(path, displacedOld);
            if (newcomerKind === "regular") await writeFile(path, "preserve me");
            else await symlink(newcomerTarget, path, "dir");
          },
        }),
      ).rejects.toThrow(/changed|identity/u);

      if (newcomerKind === "regular") {
        expect(await readFile(outDir, "utf8")).toBe("preserve me");
      } else {
        expect(await readlink(outDir)).toBe(newcomerTarget);
        expect(await readFile(join(outDir, "author.txt"), "utf8")).toBe("preserve me");
      }
      if (mode === "replacement") {
        expect(await readFile(join(displacedOld, "generation.txt"), "utf8")).toBe("old");
        expect((await listFiles(displacedOld)).sort()).toEqual(
          ownedFiles("old")
            .map((file) => file.path)
            .sort(),
        );
      }
    },
  );

  test.each([
    ["initial", "parent", "directory"],
    ["initial", "parent", "symlink"],
    ["initial", "ancestor", "directory"],
    ["initial", "ancestor", "symlink"],
    ["replacement", "parent", "directory"],
    ["replacement", "parent", "symlink"],
    ["replacement", "ancestor", "directory"],
    ["replacement", "ancestor", "symlink"],
  ] as const)(
    "rejects %s publication after the output %s is displaced by a %s newcomer",
    async (mode, displacedLevel, newcomerKind) => {
      const root = join(dir, `caller-binding-${mode}-${displacedLevel}-${newcomerKind}`);
      const parentPath = displacedLevel === "parent" ? root : join(root, "nested");
      const outDir = join(parentPath, "output");
      const bindingPath = displacedLevel === "parent" ? parentPath : root;
      const displaced = join(
        dir,
        `displaced-caller-binding-${mode}-${displacedLevel}-${newcomerKind}`,
      );
      const newcomerTarget = join(
        dir,
        `newcomer-caller-binding-${mode}-${displacedLevel}-${newcomerKind}`,
      );
      await mkdir(parentPath, { recursive: true });
      if (mode === "replacement") await replaceCompilationTree(outDir, ownedFiles("old"));

      await expect(
        replaceCompilationTree(outDir, ownedFiles("new"), {
          afterOutputTargetProof: async () => {
            await rename(bindingPath, displaced);
            const newcomerRoot = newcomerKind === "directory" ? bindingPath : newcomerTarget;
            await mkdir(displacedLevel === "parent" ? newcomerRoot : join(newcomerRoot, "nested"), {
              recursive: true,
            });
            await writeFile(join(newcomerRoot, "author.txt"), "preserve me");
            if (newcomerKind === "symlink") await symlink(newcomerTarget, bindingPath, "dir");
          },
        }),
      ).rejects.toThrow(/parent or ancestor changed/u);

      expect(await readFile(join(bindingPath, "author.txt"), "utf8")).toBe("preserve me");
      if (newcomerKind === "symlink") expect(await readlink(bindingPath)).toBe(newcomerTarget);
      await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });

      const displacedOut =
        displacedLevel === "parent"
          ? join(displaced, "output")
          : join(displaced, "nested", "output");
      if (mode === "replacement") {
        expect(await readFile(join(displacedOut, "generation.txt"), "utf8")).toBe("old");
      } else {
        await expect(lstat(displacedOut)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  test("rejects a publish pointer replaced after its own identity proof", async () => {
    const outDir = join(dir, "publish-pointer-binding");
    const displacedPointer = join(dir, "displaced-publish-pointer");
    const unrelatedGeneration = join(dir, "unrelated-publish-pointer-target");
    let replacementPointer = "";
    await replaceCompilationTree(outDir, ownedFiles("old"));
    await mkdir(unrelatedGeneration);
    await writeOwnedTree(unrelatedGeneration, "unrelated");

    await expect(
      replaceCompilationTree(outDir, ownedFiles("new"), {
        afterPublishPointerProof: async (path) => {
          const descriptorPath = path.slice(0, path.lastIndexOf("/"));
          replacementPointer = join(await readlink(descriptorPath), "current");
          await rename(path, displacedPointer);
          await symlink(unrelatedGeneration, path, "dir");
        },
      }),
    ).rejects.toThrow(/staging identity changed/u);

    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("old");
    expect((await listFiles(outDir)).sort()).toEqual(
      ownedFiles("old")
        .map((file) => file.path)
        .sort(),
    );
    expect(await readlink(replacementPointer)).toBe(unrelatedGeneration);
    expect(await readFile(join(unrelatedGeneration, "generation.txt"), "utf8")).toBe("unrelated");
    expect(await readlink(displacedPointer)).toMatch(/^\.topik-compilation-generation-/u);
  });

  test("does not delete an unowned target swapped in after ownership proof", async () => {
    const outDir = join(dir, "raced-output");
    const displaced = join(dir, "displaced-owned-output");
    await replaceCompilationTree(outDir, ownedFiles("old"));

    await expect(
      replaceCompilationTree(outDir, ownedFiles("new"), {
        beforePublish: async () => {
          await rename(outDir, displaced);
          await mkdir(outDir);
          await writeFile(join(outDir, "author.txt"), "preserve me");
        },
      }),
    ).rejects.toThrow(/identity changed/u);

    expect(await readFile(join(outDir, "author.txt"), "utf8")).toBe("preserve me");
    expect(await readFile(join(displaced, "generation.txt"), "utf8")).toBe("old");
    expect(
      (await readdir(dir)).filter((name) => name.startsWith(".topik-compilation-publish-")),
    ).not.toEqual([]);
    expect(
      (await readdir(dir)).filter((name) => name.startsWith(".topik-compilation-generation-")),
    ).toHaveLength(2);
  });

  test.each([
    ["initial", "file replacement"],
    ["initial", "unlisted file addition"],
    ["replacement", "file replacement"],
    ["replacement", "unlisted file addition"],
  ] as const)(
    "rejects %s publication after staged %s and preserves the changed staging tree",
    async (mode, mutation) => {
      const outDir = join(dir, `staged-content-race-${mode}-${mutation.replaceAll(" ", "-")}`);
      const displacedFile = join(
        dir,
        `displaced-staged-file-${mode}-${mutation.replaceAll(" ", "-")}`,
      );
      if (mode === "replacement") await replaceCompilationTree(outDir, ownedFiles("old"));
      let retainedStagedPath = "";

      await expect(
        replaceCompilationTree(outDir, ownedFiles("new"), {
          afterStagedGenerationProof: async (path) => {
            retainedStagedPath = join(dir, basename(path));
            if (mutation === "file replacement") {
              await rename(join(path, "generation.txt"), displacedFile);
              await writeFile(join(path, "generation.txt"), "newcomer");
            } else {
              await writeFile(join(path, "unlisted.txt"), "newcomer");
            }
          },
        }),
      ).rejects.toThrow(/generation contents changed/u);

      if (mode === "replacement") {
        expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("old");
      } else {
        await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const newcomerPath =
        mutation === "file replacement"
          ? join(retainedStagedPath, "generation.txt")
          : join(retainedStagedPath, "unlisted.txt");
      expect(await readFile(newcomerPath, "utf8")).toBe("newcomer");
      if (mutation === "file replacement") {
        expect(await readFile(displacedFile, "utf8")).toBe("new");
      }
    },
  );

  test.each(["descriptor", "payload"] as const)(
    "rejects replacement after prior %s mutation and preserves the prior generation",
    async (mutation) => {
      const outDir = join(dir, `prior-content-race-${mutation}`);
      await replaceCompilationTree(outDir, ownedFiles("old"));
      const oldGeneration = await readlink(outDir);
      const oldFiles = ownedFiles("old");
      const mutatedPath =
        mutation === "descriptor"
          ? ".topik/materialization.json"
          : (oldFiles.find((file) => file.path.startsWith("assets/sha256/"))?.path ?? "");
      expect(mutatedPath).not.toBe("");

      await expect(
        replaceCompilationTree(outDir, ownedFiles("new"), {
          afterPriorGenerationProof: async (path) => {
            await writeFile(join(path, mutatedPath), `changed ${mutation}`);
          },
        }),
      ).rejects.toThrow(/generation contents changed/u);

      expect(await readlink(outDir)).toBe(oldGeneration);
      expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("old");
      expect(await readFile(join(outDir, mutatedPath), "utf8")).toBe(`changed ${mutation}`);
    },
  );

  test("retains unrelated content swapped in immediately after stale-generation proof", async () => {
    const outDir = join(dir, "cleanup-race-output");
    const displaced = join(dir, "displaced-stale-generation");
    await replaceCompilationTree(outDir, ownedFiles("old"));
    const oldGeneration = await readlink(outDir);

    await replaceCompilationTree(outDir, ownedFiles("new"), {
      afterSupersededGenerationProof: async () => {
        await rename(join(dir, oldGeneration), displaced);
        await mkdir(join(dir, oldGeneration));
        await writeFile(join(dir, oldGeneration, "author.txt"), "preserve me");
      },
    });

    expect(await readFile(join(outDir, "generation.txt"), "utf8")).toBe("new");
    expect(await readFile(join(dir, oldGeneration, "author.txt"), "utf8")).toBe("preserve me");
    expect(await readFile(join(displaced, "generation.txt"), "utf8")).toBe("old");
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

import { createHash } from "node:crypto";
import {
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
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  publishDigestSnapshot,
  removeDigestSnapshot,
  type DigestSnapshotFile,
} from "./publication";

describe("Astro static Asset publication", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "topik-astro-publication-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  test("publishes and replaces exact digest snapshots without retaining a prior generation", async () => {
    const output = outputUrl(join(root, "dist"));
    const first = snapshot("first");
    const second = snapshot("second");

    await publishDigestSnapshot(output, first);
    expect(await readFile(targetFile(output, first[0].digest))).toEqual(first[0].bytes);

    await publishDigestSnapshot(output, second);
    expect(await readFile(targetFile(output, second[0].digest))).toEqual(second[0].bytes);
    expect(await readdir(assetsDirectory(output))).toEqual(["sha256"]);

    await publishDigestSnapshot(output, []);
    expect(await readdir(assetsDirectory(output))).toEqual([]);
  });

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
    "rejects %s publication after %s displacement by a %s newcomer",
    async (mode, level, newcomerKind) => {
      const caller = join(root, `caller-${mode}-${level}-${newcomerKind}`);
      const outputPath = join(caller, "nested", "dist");
      const output = outputUrl(outputPath);
      const prior = snapshot("prior");
      if (mode === "replacement") await publishDigestSnapshot(output, prior);
      else await mkdir(outputPath, { recursive: true });
      const binding = level === "parent" ? join(outputPath, "assets") : caller;
      const displaced = join(root, `displaced-${mode}-${level}-${newcomerKind}`);
      const outsider = join(root, `outsider-${mode}-${level}-${newcomerKind}`);

      await expect(
        publishDigestSnapshot(output, snapshot("next"), {
          afterTargetProof: async () => {
            await rename(binding, displaced);
            const newcomer = newcomerKind === "directory" ? binding : outsider;
            await mkdir(
              level === "parent" ? newcomer : join(newcomer, "nested", "dist", "assets"),
              { recursive: true },
            );
            await writeFile(join(newcomer, "author.txt"), "preserve me");
            if (newcomerKind === "symlink") await symlink(outsider, binding, "dir");
          },
        }),
      ).rejects.toThrow(/parent or ancestor changed/u);

      expect(await readFile(join(binding, "author.txt"), "utf8")).toBe("preserve me");
      if (newcomerKind === "symlink") expect(await readlink(binding)).toBe(outsider);
      if (mode === "replacement") {
        const displacedTarget =
          level === "parent"
            ? join(displaced, "sha256", prior[0].digest)
            : join(displaced, "nested", "dist", "assets", "sha256", prior[0].digest);
        expect(await readFile(displacedTarget)).toEqual(prior[0].bytes);
      }
    },
  );

  test.each([
    ["initial", "directory"],
    ["initial", "symlink"],
    ["replacement", "directory"],
    ["replacement", "symlink"],
  ] as const)("preserves a %s publication-reservation %s newcomer", async (mode, newcomerKind) => {
    const output = outputUrl(join(root, `reservation-${mode}-${newcomerKind}`));
    const prior = snapshot("reservation-prior");
    if (mode === "replacement") await publishDigestSnapshot(output, prior);
    let newcomerPath = "";
    let hiddenPrior = "";
    const displaced = join(root, `reservation-displaced-${mode}-${newcomerKind}`);
    const outsider = join(root, `reservation-outsider-${mode}-${newcomerKind}`);

    await expect(
      publishDigestSnapshot(output, snapshot("reservation-next"), {
        afterHiddenProof: (path, phase) => {
          if (phase === "publish") {
            hiddenPrior = join(assetsDirectory(output), basename(path));
          }
        },
        afterReservedProof: async (path, purpose) => {
          if (purpose !== "publish") return;
          newcomerPath = join(assetsDirectory(output), basename(path));
          await rename(path, displaced);
          if (newcomerKind === "directory") {
            await mkdir(path);
            await writeFile(join(path, "author.txt"), "preserve me");
          } else {
            await mkdir(outsider);
            await writeFile(join(outsider, "author.txt"), "preserve me");
            await symlink(outsider, path, "dir");
          }
        },
      }),
    ).rejects.toThrow(/binding changed/u);

    expect(await readFile(join(newcomerPath, "author.txt"), "utf8")).toBe("preserve me");
    if (newcomerKind === "symlink") expect(await readlink(newcomerPath)).toBe(outsider);
    if (mode === "replacement") {
      expect(await readFile(join(hiddenPrior, prior[0].digest))).toEqual(prior[0].bytes);
    }
  });

  test.each(["directory", "symlink"] as const)(
    "preserves a %s newcomer swapped over the backup reservation",
    async (newcomerKind) => {
      const output = outputUrl(join(root, `backup-reservation-${newcomerKind}`));
      const prior = snapshot("backup-reservation-prior");
      await publishDigestSnapshot(output, prior);
      let newcomerPath = "";
      const displaced = join(root, `backup-reservation-displaced-${newcomerKind}`);
      const outsider = join(root, `backup-reservation-outsider-${newcomerKind}`);

      await expect(
        publishDigestSnapshot(output, snapshot("backup-reservation-next"), {
          afterReservedProof: async (path, purpose) => {
            if (purpose !== "backup") return;
            newcomerPath = join(assetsDirectory(output), basename(path));
            await rename(path, displaced);
            if (newcomerKind === "directory") {
              await mkdir(path);
              await writeFile(join(path, "author.txt"), "preserve me");
            } else {
              await mkdir(outsider);
              await writeFile(join(outsider, "author.txt"), "preserve me");
              await symlink(outsider, path, "dir");
            }
          },
        }),
      ).rejects.toThrow(/binding changed/u);

      expect(await readFile(targetFile(output, prior[0].digest))).toEqual(prior[0].bytes);
      expect(await readFile(join(newcomerPath, "author.txt"), "utf8")).toBe("preserve me");
      if (newcomerKind === "symlink") expect(await readlink(newcomerPath)).toBe(outsider);
    },
  );

  test.each([
    ["parent", "directory"],
    ["parent", "symlink"],
    ["ancestor", "directory"],
    ["ancestor", "symlink"],
  ] as const)(
    "rejects startup cleanup after %s displacement by a %s newcomer",
    async (level, newcomerKind) => {
      const caller = join(root, `cleanup-caller-${level}-${newcomerKind}`);
      const outputPath = join(caller, "nested", "dist");
      const output = outputUrl(outputPath);
      const prior = snapshot("cleanup-prior");
      await publishDigestSnapshot(output, prior);
      const binding = level === "parent" ? join(outputPath, "assets") : caller;
      const displaced = join(root, `cleanup-displaced-${level}-${newcomerKind}`);
      const outsider = join(root, `cleanup-outsider-${level}-${newcomerKind}`);

      await expect(
        removeDigestSnapshot(output, {
          afterTargetProof: async () => {
            await rename(binding, displaced);
            const newcomer = newcomerKind === "directory" ? binding : outsider;
            await mkdir(
              level === "parent" ? newcomer : join(newcomer, "nested", "dist", "assets"),
              { recursive: true },
            );
            await writeFile(join(newcomer, "author.txt"), "preserve me");
            if (newcomerKind === "symlink") await symlink(outsider, binding, "dir");
          },
        }),
      ).rejects.toThrow(/parent or ancestor changed/u);

      expect(await readFile(join(binding, "author.txt"), "utf8")).toBe("preserve me");
      if (newcomerKind === "symlink") expect(await readlink(binding)).toBe(outsider);
      const displacedTarget =
        level === "parent"
          ? join(displaced, "sha256", prior[0].digest)
          : join(displaced, "nested", "dist", "assets", "sha256", prior[0].digest);
      expect(await readFile(displacedTarget)).toEqual(prior[0].bytes);
    },
  );

  test.each([
    ["initial", "directory"],
    ["initial", "symlink"],
    ["replacement", "directory"],
    ["replacement", "symlink"],
  ] as const)(
    "rejects %s publication after the staged directory is replaced by a %s",
    async (mode, newcomerKind) => {
      const output = outputUrl(join(root, `stage-${mode}-${newcomerKind}`));
      const prior = snapshot("stage-prior");
      if (mode === "replacement") await publishDigestSnapshot(output, prior);
      const displaced = join(root, `stage-displaced-${mode}-${newcomerKind}`);
      const outsider = join(root, `stage-outsider-${mode}-${newcomerKind}`);
      let newcomerPath = "";

      await expect(
        publishDigestSnapshot(output, snapshot("stage-next"), {
          afterStageProof: async (path) => {
            newcomerPath = join(assetsDirectory(output), basename(path));
            await rename(path, displaced);
            if (newcomerKind === "directory") {
              await mkdir(path);
              await writeFile(join(path, "author.txt"), "preserve me");
            } else {
              await mkdir(outsider);
              await writeFile(join(outsider, "author.txt"), "preserve me");
              await symlink(outsider, path, "dir");
            }
          },
        }),
      ).rejects.toThrow(/binding changed|contents changed/u);

      expect(await readFile(join(newcomerPath, "author.txt"), "utf8")).toBe("preserve me");
      if (newcomerKind === "symlink") expect(await readlink(newcomerPath)).toBe(outsider);
      if (mode === "replacement") {
        expect(await readFile(targetFile(output, prior[0].digest))).toEqual(prior[0].bytes);
      }
      expect(await readFile(join(displaced, snapshot("stage-next")[0].digest))).toEqual(
        snapshot("stage-next")[0].bytes,
      );
    },
  );

  test.each([
    ["initial", "directory"],
    ["initial", "symlink"],
    ["replacement", "directory"],
    ["replacement", "symlink"],
  ] as const)(
    "preserves a %s target %s inserted after target proof",
    async (mode, newcomerKind) => {
      const output = outputUrl(join(root, `target-${mode}-${newcomerKind}`));
      const prior = snapshot("target-prior");
      if (mode === "replacement") await publishDigestSnapshot(output, prior);
      else await mkdir(assetsDirectory(output), { recursive: true });
      const target = join(assetsDirectory(output), "sha256");
      const displaced = join(root, `target-displaced-${mode}-${newcomerKind}`);
      const outsider = join(root, `target-outsider-${mode}-${newcomerKind}`);

      await expect(
        publishDigestSnapshot(output, snapshot("target-next"), {
          afterTargetProof: async () => {
            if (mode === "replacement") await rename(target, displaced);
            if (newcomerKind === "directory") {
              await mkdir(target);
              await writeFile(join(target, "author.txt"), "preserve me");
            } else {
              await mkdir(outsider);
              await writeFile(join(outsider, "author.txt"), "preserve me");
              await symlink(outsider, target, "dir");
            }
          },
        }),
      ).rejects.toThrow(/changed|binding/u);

      expect(await readFile(join(target, "author.txt"), "utf8")).toBe("preserve me");
      if (newcomerKind === "symlink") expect(await readlink(target)).toBe(outsider);
      if (mode === "replacement") {
        expect(await readFile(join(displaced, prior[0].digest))).toEqual(prior[0].bytes);
      }
    },
  );

  test("rejects a mutation of the complete prior snapshot before replacement", async () => {
    const output = outputUrl(join(root, "prior-mutation"));
    const prior = snapshot("prior-mutation");
    const displaced = join(root, "prior-mutation-displaced");
    await publishDigestSnapshot(output, prior);

    await expect(
      publishDigestSnapshot(output, snapshot("next-mutation"), {
        afterPriorProof: async (path) => {
          await rename(join(path, prior[0].digest), displaced);
          await writeFile(join(path, prior[0].digest), "mutated prior");
        },
      }),
    ).rejects.toThrow(/digest|contents changed/u);

    expect(await readFile(targetFile(output, prior[0].digest), "utf8")).toBe("mutated prior");
    expect(await readFile(displaced)).toEqual(prior[0].bytes);
  });

  test.each(["directory", "symlink"] as const)(
    "preserves a %s newcomer swapped over the hidden prior during cleanup",
    async (newcomerKind) => {
      const output = outputUrl(join(root, `cleanup-swap-${newcomerKind}`));
      const prior = snapshot("cleanup-swap-prior");
      const next = snapshot("cleanup-swap-next");
      await publishDigestSnapshot(output, prior);
      const displaced = join(root, `cleanup-swap-displaced-${newcomerKind}`);
      const outsider = join(root, `cleanup-swap-outsider-${newcomerKind}`);
      let newcomerPath = "";

      await expect(
        publishDigestSnapshot(output, next, {
          afterCleanupProof: async (path, kind) => {
            if (kind !== "prior") return;
            newcomerPath = join(assetsDirectory(output), basename(path));
            await rename(path, displaced);
            if (newcomerKind === "directory") {
              await mkdir(path);
              await writeFile(join(path, "author.txt"), "preserve me");
            } else {
              await mkdir(outsider);
              await writeFile(join(outsider, "author.txt"), "preserve me");
              await symlink(outsider, path, "dir");
            }
          },
        }),
      ).rejects.toThrow(/binding changed/u);

      expect(await readFile(targetFile(output, next[0].digest))).toEqual(next[0].bytes);
      expect(await readFile(join(newcomerPath, "author.txt"), "utf8")).toBe("preserve me");
      if (newcomerKind === "symlink") expect(await readlink(newcomerPath)).toBe(outsider);
      expect(await readFile(join(displaced, prior[0].digest))).toEqual(prior[0].bytes);
    },
  );

  test.each(["directory", "symlink"] as const)(
    "preserves a %s newcomer swapped over startup-cleanup storage",
    async (newcomerKind) => {
      const output = outputUrl(join(root, `startup-cleanup-swap-${newcomerKind}`));
      const prior = snapshot("startup-cleanup-swap-prior");
      await publishDigestSnapshot(output, prior);
      const displaced = join(root, `startup-cleanup-displaced-${newcomerKind}`);
      const outsider = join(root, `startup-cleanup-outsider-${newcomerKind}`);
      let newcomerPath = "";

      await expect(
        removeDigestSnapshot(output, {
          afterCleanupProof: async (path, kind) => {
            if (kind !== "removed") return;
            newcomerPath = join(assetsDirectory(output), basename(path));
            await rename(path, displaced);
            if (newcomerKind === "directory") {
              await mkdir(path);
              await writeFile(join(path, "author.txt"), "preserve me");
            } else {
              await mkdir(outsider);
              await writeFile(join(outsider, "author.txt"), "preserve me");
              await symlink(outsider, path, "dir");
            }
          },
        }),
      ).rejects.toThrow(/binding changed/u);

      expect(await readFile(join(newcomerPath, "author.txt"), "utf8")).toBe("preserve me");
      if (newcomerKind === "symlink") expect(await readlink(newcomerPath)).toBe(outsider);
      expect(await readFile(join(displaced, prior[0].digest))).toEqual(prior[0].bytes);
    },
  );

  test("preserves a cleanup-file newcomer and the displaced proven payload", async () => {
    const output = outputUrl(join(root, "cleanup-file"));
    const prior = snapshot("cleanup-file-prior");
    const next = snapshot("cleanup-file-next");
    const displaced = join(root, "cleanup-file-displaced");
    await publishDigestSnapshot(output, prior);

    await expect(
      publishDigestSnapshot(output, next, {
        afterCleanupFileProof: async (path, kind) => {
          if (kind !== "prior") return;
          await rename(path, displaced);
          await writeFile(path, "preserve newcomer");
        },
      }),
    ).rejects.toThrow(/digest|cleanup file changed/u);

    expect(await readFile(targetFile(output, next[0].digest))).toEqual(next[0].bytes);
    expect(await readFile(displaced)).toEqual(prior[0].bytes);
    const hidden = (await readdir(assetsDirectory(output))).find((name) =>
      name.startsWith(".topik-sha256-hidden-"),
    );
    expect(hidden).toBeDefined();
    expect(
      await readFile(join(assetsDirectory(output), hidden ?? "", prior[0].digest), "utf8"),
    ).toBe("preserve newcomer");
  });

  test("restores the exact prior after a displaced stage blocks replacement", async () => {
    const output = outputUrl(join(root, "restore-prior"));
    const prior = snapshot("restore-prior");
    await publishDigestSnapshot(output, prior);
    let stagePath = "";
    let stageNewcomer = "";
    const displacedStage = join(root, "restore-displaced-stage");

    await expect(
      publishDigestSnapshot(output, snapshot("restore-next"), {
        afterHiddenProof: async (_path, phase) => {
          if (phase !== "publish") return;
          await rename(stagePath, displacedStage);
          await mkdir(stagePath);
          await writeFile(join(stagePath, "author.txt"), "preserve me");
        },
        afterStageProof: (path) => {
          stagePath = path;
          stageNewcomer = join(assetsDirectory(output), basename(path));
        },
      }),
    ).rejects.toThrow(/binding changed/u);

    expect(await readFile(targetFile(output, prior[0].digest))).toEqual(prior[0].bytes);
    expect(await readFile(join(stageNewcomer, "author.txt"), "utf8")).toBe("preserve me");
  });

  test.each(["directory", "symlink"] as const)(
    "never restores over a %s newcomer inserted at the restore seam",
    async (newcomerKind) => {
      const output = outputUrl(join(root, `restore-newcomer-${newcomerKind}`));
      const prior = snapshot("restore-newcomer-prior");
      await publishDigestSnapshot(output, prior);
      let stagePath = "";
      let hiddenPrior = "";
      const displacedStage = join(root, `restore-newcomer-stage-${newcomerKind}`);
      const displacedReservation = join(root, `restore-reservation-${newcomerKind}`);
      const outsider = join(root, `restore-outsider-${newcomerKind}`);

      await expect(
        publishDigestSnapshot(output, snapshot("restore-newcomer-next"), {
          afterHiddenProof: async (path, phase) => {
            if (phase !== "publish") return;
            hiddenPrior = join(assetsDirectory(output), basename(path));
            await rename(stagePath, displacedStage);
            await mkdir(stagePath);
          },
          afterRestoreProof: async (path) => {
            await rename(path, displacedReservation);
            if (newcomerKind === "directory") {
              await mkdir(path);
              await writeFile(join(path, "author.txt"), "preserve me");
            } else {
              await mkdir(outsider);
              await writeFile(join(outsider, "author.txt"), "preserve me");
              await symlink(outsider, path, "dir");
            }
          },
          afterStageProof: (path) => {
            stagePath = path;
          },
        }),
      ).rejects.toThrow(/binding changed/u);

      const target = join(assetsDirectory(output), "sha256");
      expect(await readFile(join(target, "author.txt"), "utf8")).toBe("preserve me");
      if (newcomerKind === "symlink") expect(await readlink(target)).toBe(outsider);
      expect(await readFile(join(hiddenPrior, prior[0].digest))).toEqual(prior[0].bytes);
    },
  );
});

function snapshot(label: string): DigestSnapshotFile[] {
  const bytes = Buffer.from(label);
  return [{ bytes, digest: createHash("sha256").update(bytes).digest("hex") }];
}

function outputUrl(path: string): URL {
  return pathToFileURL(`${path}/`);
}

function assetsDirectory(output: URL): string {
  return join(output.pathname, "assets");
}

function targetFile(output: URL, digest: string): string {
  return join(assetsDirectory(output), "sha256", digest);
}

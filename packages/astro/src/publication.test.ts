import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
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

  test("publishes, replaces, and removes complete digest snapshots without temporary artifacts", async () => {
    const output = outputUrl(join(root, "dist"));
    const first = snapshot("first");
    const second = snapshot("second");

    await publishDigestSnapshot(output, first);
    expect(await readFile(targetFile(output, first[0].digest))).toEqual(first[0].bytes);

    await publishDigestSnapshot(output, second);
    expect(await readFile(targetFile(output, second[0].digest))).toEqual(second[0].bytes);
    expect(await readdir(fileURLToPath(output))).toEqual(["blobs"]);

    await removeDigestSnapshot(output);
    expect(await readdir(fileURLToPath(output))).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "publishes world-traversable directories and readable files",
    async () => {
      const outputPath = join(root, "served", "dist");
      const files = snapshot("served");

      await publishDigestSnapshot(outputUrl(outputPath), files);

      expect((await stat(join(root, "served"))).mode & 0o777).toBe(0o755);
      expect((await stat(outputPath)).mode & 0o777).toBe(0o755);
      expect((await stat(join(outputPath, "blobs"))).mode & 0o777).toBe(0o755);
      expect((await stat(join(outputPath, "blobs", files[0].digest))).mode & 0o777).toBe(0o444);
    },
  );

  test("snapshots caller-owned bytes before asynchronous staging", async () => {
    const output = outputUrl(join(root, "snapshot"));
    const bytes = Buffer.from("complete payload");
    const expected = Buffer.from(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");

    const publication = publishDigestSnapshot(output, [{ bytes, digest }]);
    bytes.fill(0);
    await publication;

    expect(await readFile(targetFile(output, digest))).toEqual(expected);
  });

  test.each([
    { files: [{ bytes: Buffer.from("payload"), digest: "short" }] },
    { files: [...snapshot("duplicate"), ...snapshot("duplicate")] },
    { files: [{ bytes: Buffer.from("payload"), digest: "0".repeat(64) }] },
  ])("rejects a noncanonical compiler snapshot before creating output", async ({ files }) => {
    const output = outputUrl(join(root, "invalid"));

    await expect(publishDigestSnapshot(output, files)).rejects.toThrow(/snapshot/u);
    await expect(readdir(join(root, "invalid"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a symlinked output ancestor without writing outside it", async () => {
    const outputPath = join(root, "linked", "dist");
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, "linked"), "dir");

    await expect(publishDigestSnapshot(outputUrl(outputPath), snapshot("blocked"))).rejects.toThrow(
      /link or non-directory ancestor/u,
    );
    expect(await readdir(outside)).toEqual([]);
  });

  test("rejects a symlinked digest target without following or changing its destination", async () => {
    const output = outputUrl(join(root, "target-link"));
    const outside = join(root, "outside-target");
    await mkdir(fileURLToPath(output), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "author.txt"), "preserve me");
    await symlink(outside, join(fileURLToPath(output), "blobs"), "dir");

    await expect(publishDigestSnapshot(output, snapshot("blocked"))).rejects.toThrow(
      /link or non-directory collision/u,
    );
    expect(await readFile(join(outside, "author.txt"), "utf8")).toBe("preserve me");
    expect(await readdir(fileURLToPath(output))).toEqual(["blobs"]);
  });

  test.each(["noncanonical", "digest-mismatch", "special"] as const)(
    "rejects an unsafe pre-existing digest tree (%s) before replacement",
    async (kind) => {
      const output = outputUrl(join(root, `unsafe-${kind}`));
      const target = join(fileURLToPath(output), "blobs");
      await mkdir(target, { recursive: true });
      if (kind === "noncanonical") {
        await writeFile(join(target, "author.txt"), "preserve me");
      } else if (kind === "digest-mismatch") {
        await writeFile(join(target, "0".repeat(64)), "different bytes");
      } else {
        const socketPath = join(target, "0".repeat(64));
        execFileSync("mkfifo", [socketPath]);
      }

      await expect(publishDigestSnapshot(output, snapshot("next"))).rejects.toThrow(
        /non-canonical|digest|unsafe/u,
      );
      expect(await readdir(fileURLToPath(output))).toEqual(["blobs"]);
    },
  );
});

describe("Astro static Asset publication with anchored file safety off Linux", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "topik-astro-publication-platform-"));
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { force: true, recursive: true });
  });

  test("an empty snapshot with no prior output is a no-op", async () => {
    const missing = outputUrl(join(root, "missing"));
    const empty = outputUrl(join(root, "empty"));
    await mkdir(fileURLToPath(empty));

    await removeDigestSnapshot(missing, "anchored");
    await removeDigestSnapshot(empty, "anchored");
    await publishDigestSnapshot(missing, [], "anchored");
    await publishDigestSnapshot(empty, [], "anchored");

    await expect(readdir(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fileURLToPath(empty))).toEqual([]);
  });

  test("refuses to publish Assets with a clear Linux requirement", async () => {
    const output = outputUrl(join(root, "dist"));

    await expect(publishDigestSnapshot(output, snapshot("asset"), "anchored")).rejects.toThrow(
      /^Topik Asset publication requires Linux/u,
    );
    await expect(readdir(join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to remove or replace an existing digest tree", async () => {
    const output = outputUrl(join(root, "prior"));
    await mkdir(join(fileURLToPath(output), "blobs"), { recursive: true });

    await expect(removeDigestSnapshot(output, "anchored")).rejects.toThrow(/requires Linux/u);
    await expect(publishDigestSnapshot(output, [], "anchored")).rejects.toThrow(/requires Linux/u);
    expect(await readdir(fileURLToPath(output))).toEqual(["blobs"]);
  });
});

describe.each(["darwin", "win32"] as const)(
  "Astro static Asset publication with portable file safety on simulated %s",
  (platform) => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "topik-astro-publication-portable-"));
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await rm(root, { force: true, recursive: true });
    });

    test("publishes, replaces, and removes snapshots by default", async () => {
      const output = outputUrl(join(root, "dist"));
      const first = snapshot("first");
      const second = snapshot("second");

      await publishDigestSnapshot(output, first);
      expect(await readFile(targetFile(output, first[0].digest))).toEqual(first[0].bytes);

      await publishDigestSnapshot(output, second);
      expect(await readdir(join(fileURLToPath(output), "blobs"))).toEqual([second[0].digest]);
      expect(await readdir(fileURLToPath(output))).toEqual(["blobs"]);

      await publishDigestSnapshot(output, []);
      expect(await readdir(fileURLToPath(output))).toEqual([]);

      await publishDigestSnapshot(output, first);
      await removeDigestSnapshot(output);
      expect(await readdir(fileURLToPath(output))).toEqual([]);
    });

    test.skipIf(process.platform === "win32")(
      "publishes world-traversable directories and readable files",
      async () => {
        const outputPath = join(root, "served", "dist");
        const files = snapshot("served");

        await publishDigestSnapshot(outputUrl(outputPath), files);

        expect((await stat(join(outputPath, "blobs"))).mode & 0o777).toBe(0o755);
        expect((await stat(join(outputPath, "blobs", files[0].digest))).mode & 0o777).toBe(0o444);
      },
    );

    test("replaces and removes an empty blobs directory", async () => {
      const output = outputUrl(join(root, "empty-target"));
      await mkdir(join(fileURLToPath(output), "blobs"), { recursive: true });
      await publishDigestSnapshot(output, snapshot("into-empty"));
      expect(await readdir(join(fileURLToPath(output), "blobs"))).toHaveLength(1);

      await rm(join(fileURLToPath(output), "blobs"), { recursive: true });
      await mkdir(join(fileURLToPath(output), "blobs"));
      await removeDigestSnapshot(output);
      expect(await readdir(fileURLToPath(output))).toEqual([]);
    });

    test("rejects a symlinked digest target without following or changing its destination", async () => {
      const output = outputUrl(join(root, "target-link"));
      const outside = join(root, "outside-target");
      await mkdir(fileURLToPath(output), { recursive: true });
      await mkdir(outside);
      await writeFile(join(outside, "author.txt"), "preserve me");
      await symlink(outside, join(fileURLToPath(output), "blobs"), "dir");

      await expect(publishDigestSnapshot(output, snapshot("blocked"))).rejects.toThrow(
        /link or non-directory collision/u,
      );
      await expect(removeDigestSnapshot(output)).rejects.toThrow(
        /link or non-directory collision/u,
      );
      expect(await readFile(join(outside, "author.txt"), "utf8")).toBe("preserve me");
      expect(await readdir(fileURLToPath(output))).toEqual(["blobs"]);
    });

    test.each(["noncanonical", "digest-mismatch", "subdirectory"] as const)(
      "refuses to replace or remove a foreign blobs directory (%s)",
      async (kind) => {
        const output = outputUrl(join(root, `foreign-${kind}`));
        const target = join(fileURLToPath(output), "blobs");
        await mkdir(target, { recursive: true });
        if (kind === "noncanonical") await writeFile(join(target, "author.txt"), "preserve me");
        else if (kind === "digest-mismatch") {
          await writeFile(join(target, "0".repeat(64)), "different bytes");
        } else await mkdir(join(target, "0".repeat(64)));

        await expect(publishDigestSnapshot(output, snapshot("next"))).rejects.toThrow(/unsafe/u);
        await expect(removeDigestSnapshot(output)).rejects.toThrow(/unsafe/u);
        expect(await readdir(fileURLToPath(output))).toEqual(["blobs"]);
        expect(await readdir(target)).toHaveLength(1);
      },
    );
  },
);

function snapshot(label: string): DigestSnapshotFile[] {
  const bytes = Buffer.from(label);
  return [{ bytes, digest: createHash("sha256").update(bytes).digest("hex") }];
}

function outputUrl(path: string): URL {
  return pathToFileURL(`${path}/`);
}

function targetFile(output: URL, digest: string): string {
  return join(fileURLToPath(output), "blobs", digest);
}

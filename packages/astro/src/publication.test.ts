import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("publishes, replaces, and removes complete digest snapshots without temporary artifacts", async () => {
    const output = outputUrl(join(root, "dist"));
    const first = snapshot("first");
    const second = snapshot("second");

    await publishDigestSnapshot(output, first);
    expect(await readFile(targetFile(output, first[0].digest))).toEqual(first[0].bytes);

    await publishDigestSnapshot(output, second);
    expect(await readFile(targetFile(output, second[0].digest))).toEqual(second[0].bytes);
    expect(await readdir(output.pathname)).toEqual(["blobs"]);

    await removeDigestSnapshot(output);
    expect(await readdir(output.pathname)).toEqual([]);
  });

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
    await mkdir(output.pathname, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "author.txt"), "preserve me");
    await symlink(outside, join(output.pathname, "blobs"), "dir");

    await expect(publishDigestSnapshot(output, snapshot("blocked"))).rejects.toThrow(
      /link or non-directory collision/u,
    );
    expect(await readFile(join(outside, "author.txt"), "utf8")).toBe("preserve me");
    expect(await readdir(output.pathname)).toEqual(["blobs"]);
  });

  test.each(["noncanonical", "digest-mismatch", "special"] as const)(
    "rejects an unsafe pre-existing digest tree (%s) before replacement",
    async (kind) => {
      const output = outputUrl(join(root, `unsafe-${kind}`));
      const target = join(output.pathname, "blobs");
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
      expect(await readdir(output.pathname)).toEqual(["blobs"]);
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

function targetFile(output: URL, digest: string): string {
  return join(output.pathname, "blobs", digest);
}

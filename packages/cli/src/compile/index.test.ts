import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { compile } from "./index";

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
    clean: boolean;
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
      clean: false,
      validate: true,
      links: "error",
      sourceNamespace: "cli-test-source",
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Asset\/auto-v1-[a-z2-7]{52}\.json$/u));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^assets\/sha256\/[0-9a-f]{64}$/u));
  });

  test("discovers explicit descriptors without requiring a source namespace", async () => {
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "manual.bin"), "manual bytes\n");
    await writeFile(
      join(dir, "assets", "manual.yaml"),
      "apiVersion: v1\ntype: Asset\nname: manual\nspec:\n  uri: manual.bin\n",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await (compile as CompileCommand).handler?.({
      dir,
      format: "json",
      dryRun: true,
      clean: false,
      validate: true,
      links: "error",
    });

    expect(log).toHaveBeenCalledWith("Asset/manual.json");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^assets\/sha256\/[0-9a-f]{64}$/u));
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
      clean: false,
      validate: true,
      links: "error" as const,
      sourceNamespace: "cli-test-source",
    };
    await (compile as CompileCommand).handler?.(options);
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
    expect(await readFile(join(outDir, ".topik", "materialization.json"))).toEqual(firstIdentity);
    await expect(readFile(join(outDir, "stale.bin"))).rejects.toMatchObject({ code: "ENOENT" });
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
        clean: false,
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
        clean: false,
        validate: true,
        links: "error",
      }),
    ).rejects.toThrow(/hard link/u);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });
});

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

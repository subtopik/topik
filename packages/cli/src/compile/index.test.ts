import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    format: "json" | "jsonl" | "yaml";
    dryRun: boolean;
    clean: boolean;
    validate: boolean;
    links: "error" | "warning" | "off";
  }) => Promise<void>;
};

describe("compile command", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-compile-"));
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  test("prints compiled output names in dry-run mode", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      (compile as CompileCommand).handler?.({
        dir,
        format: "json",
        dryRun: true,
        clean: false,
        validate: false,
        links: "error",
      }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^WikiPage\/docs-[a-f0-9]{16}\.json$/));
    expect(log).toHaveBeenCalledWith("Wiki/docs.json");
  });

  test("writes each content resource to a collision-free portable root", async () => {
    const outDir = join(dir, "compiled");
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
    ).resolves.toBeUndefined();

    const [pageName] = await readdir(join(outDir, "portable", "WikiPage"));
    const portableRoot = join(outDir, "portable", "WikiPage", pageName);
    expect(JSON.parse(await readFile(join(portableRoot, "resource.json"), "utf8"))).toMatchObject({
      apiVersion: "v1",
      type: "WikiPage",
      name: pageName,
    });
    expect(await readFile(join(portableRoot, "content.topik"), "utf8")).toBe("# Intro\n");
    expect(
      JSON.parse(await readFile(join(portableRoot, ".topik", "assets.json"), "utf8")),
    ).toMatchObject({
      type: "AssetManifest",
      resource: { apiVersion: "v1", type: "WikiPage", name: pageName },
      assets: {},
    });
  });

  test("persists portable key state so repeated CLI compilation keeps exact sidecar bytes", async () => {
    await rm(join(dir, "wiki.yaml"));
    await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](hero.png)\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    const outDir = join(dir, "compiled");
    const options = {
      dir,
      outDir,
      format: "json" as const,
      dryRun: false,
      clean: false,
      validate: true,
      links: "error" as const,
    };

    await (compile as CompileCommand).handler?.(options);
    const sidecarPath = join(outDir, "portable", "Guide", "docs-intro", ".topik", "assets.json");
    const first = await readFile(sidecarPath);
    await (compile as CompileCommand).handler?.(options);
    expect(await readFile(sidecarPath)).toEqual(first);
    expect(
      JSON.parse(await readFile(join(outDir, ".topik", "asset-key-state.json"), "utf8")),
    ).toMatchObject({ version: "topik-portable-asset-keys-v1" });
  });

  test.each(["resource-root", "type-directory"])(
    "rejects an existing portable %s symlink without writing through it",
    async (placement) => {
      await rm(join(dir, "wiki.yaml"));
      await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
      await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](hero.png)\n");
      await writeFile(join(dir, "hero.png"), PNG_BYTES);
      const outDir = join(dir, "compiled");
      const outside = await mkdtemp(join(tmpdir(), "topik-cli-compile-outside-"));
      try {
        if (placement === "resource-root") {
          await mkdir(join(outDir, "portable", "Guide"), { recursive: true });
          await symlink(outside, join(outDir, "portable", "Guide", "docs-intro"), "dir");
        } else {
          await mkdir(join(outDir, "portable"), { recursive: true });
          await symlink(outside, join(outDir, "portable", "Guide"), "dir");
        }

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
        ).rejects.toThrow(/link or non-directory collision/u);
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  test("replaces each portable output tree with the exact current inventory", async () => {
    await rm(join(dir, "wiki.yaml"));
    await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](hero.png)\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    const outDir = join(dir, "compiled");
    const options = {
      dir,
      outDir,
      format: "json" as const,
      dryRun: false,
      clean: false,
      validate: true,
      links: "error" as const,
    };

    await (compile as CompileCommand).handler?.(options);
    const portableRoot = join(outDir, "portable", "Guide", "docs-intro");
    expect(await readFile(join(portableRoot, "hero.png"))).toEqual(PNG_BYTES);
    await writeFile(join(portableRoot, "stale.bin"), "stale");
    await writeFile(join(dir, "intro.md"), "# Intro\n");

    await (compile as CompileCommand).handler?.(options);
    await expect(readFile(join(portableRoot, "hero.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(portableRoot, "stale.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      JSON.parse(await readFile(join(portableRoot, ".topik", "assets.json"), "utf8")),
    ).toMatchObject({ assets: {} });
  });
});

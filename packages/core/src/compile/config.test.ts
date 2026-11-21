import { link, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { readExactConfigFile, readOptionalConfigFileWithPath } from "./config";
import { compileGuides } from "./guide";
import { PublicCompileError } from "./public-errors";
import { compileWiki } from "./wiki";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

// Emulate other platforms only from Linux: another host's filesystem would fail the emulated
// platform's file checks (NTFS keeps small files in the MFT with no allocated blocks).
const PLATFORMS =
  process.platform === "linux" ? (["native", "darwin", "win32"] as const) : (["native"] as const);

describe("compile config helpers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "topik-config-")));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(open).mockReset();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation(actual.open);
    await rm(dir, { recursive: true, force: true });
  });

  test("reads the first available config file", async () => {
    await writeFile(join(dir, "wiki.yml"), "id: docs\ntitle: Docs\n");

    await expect(readOptionalConfigFileWithPath(dir, ["wiki.yaml", "wiki.yml"])).resolves.toEqual({
      path: "wiki.yml",
      value: { id: "docs", title: "Docs" },
    });
  });

  test("returns nothing when all candidates are missing", async () => {
    const candidates = ["wiki.yaml", "wiki.yml", "wiki.json"];
    await expect(readOptionalConfigFileWithPath(dir, candidates)).resolves.toBeUndefined();
  });

  test("parses conventional configs as selected ones are parsed", async () => {
    await writeFile(join(dir, "wiki.yaml"), "base: &t Docs\nid: docs\ntitle: *t\n");
    await expect(readOptionalConfigFileWithPath(dir, ["wiki.yaml"])).rejects.toMatchObject({
      id: "config-parse-failed",
      location: "wiki.yaml",
    });
    await writeFile(
      join(dir, "wiki.json"),
      `\uFEFF${JSON.stringify({ id: "docs", title: "Docs" })}`,
    );
    await expect(readOptionalConfigFileWithPath(dir, ["wiki.json"])).resolves.toEqual({
      path: "wiki.json",
      value: { id: "docs", title: "Docs" },
    });
  });

  test.each(PLATFORMS)(
    "reads configs and preserves missing-candidate fallback on %s",
    async (platform) => {
      await writeFile(join(dir, "wiki.yml"), "id: docs\ntitle: Docs\n");
      await writeFile(join(dir, "wiki.json"), JSON.stringify({ id: "other", title: "Other" }));
      if (platform !== "native") vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const candidates = ["wiki.yaml", "wiki.yml", "wiki.json"];

      await expect(readOptionalConfigFileWithPath(dir, candidates)).resolves.toEqual({
        path: "wiki.yml",
        value: { id: "docs", title: "Docs" },
      });
      await expect(readOptionalConfigFileWithPath(dir, ["missing.yaml"])).resolves.toBeUndefined();
    },
  );

  test.each(PLATFORMS)(
    "standalone Wiki and Guide compilers read ordinary sources on %s",
    async (platform) => {
      await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation: [intro]\n");
      await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
      const content = "# Intro\n\nSource content.\n";
      await writeFile(join(dir, "intro.md"), content);
      if (platform !== "native") vi.spyOn(process, "platform", "get").mockReturnValue(platform);

      const wiki = await compileWiki({ dir });
      expect(wiki.resources).toContainEqual(
        expect.objectContaining({
          type: "WikiPage",
          spec: expect.objectContaining({
            title: "Intro",
            content: { format: "topik", value: content },
          }),
        }),
      );
      const guides = await compileGuides({ dir });
      expect(guides.resources).toContainEqual(
        expect.objectContaining({
          type: "Guide",
          name: "guides-intro",
          spec: expect.objectContaining({
            title: "Intro",
            content: { format: "topik", value: content },
          }),
        }),
      );
    },
  );

  test.skipIf(process.platform !== "linux")(
    "reports unavailable procfs through config reads and standalone compilers as compile does",
    async () => {
      await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation: [intro]\n");
      await writeFile(join(dir, "wiki.json"), JSON.stringify({ id: "other", title: "Other" }));
      await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
      await writeFile(join(dir, "intro.md"), "# Intro\n");
      vi.mocked(open).mockImplementation(
        async () =>
          ({
            fd: 2147483647,
            stat: async () => ({ isDirectory: () => true }),
            close: async () => {},
          }) as Awaited<ReturnType<typeof open>>,
      );
      await expectUnsupported(
        () => readOptionalConfigFileWithPath(dir, ["wiki.yaml", "wiki.json"]),
        "wiki.yaml",
      );
      await expectUnsupported(() => compileWiki({ dir }), "wiki.yaml");
      await expectUnsupported(() => compileGuides({ dir }), "collection.yaml");
    },
  );

  test("standalone compilers take the same read options as compile", async () => {
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation: [intro]\n");
    await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n");
    // A malformed Git executable is refused before any read, proving the option is used.
    for (const compileSource of [compileWiki, compileGuides])
      await expect(compileSource({ dir, gitExecutable: "relative/git" })).rejects.toThrow(
        TypeError,
      );
    await expect(compileWiki({ dir, fileSafety: "portable" })).resolves.toMatchObject({
      diagnostics: [],
    });
  });

  async function expectUnsupported(action: () => Promise<unknown>, location: string) {
    const error: unknown = await action().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PublicCompileError);
    expect(error).toMatchObject({ id: "config-read-failed", location });
    // The reader's diagnostics stay a non-enumerable debugging aid.
    expect(Object.keys(error as object)).not.toContain("cause");
    expect(`${String(error)}\n${JSON.stringify(error)}`).not.toContain(dir);
  }

  // Exact config reads use the Linux-only descriptor-anchored reader.
  test.skipIf(process.platform !== "linux")(
    "reads exact config text that mentions Git LFS and rejects a pointer",
    async () => {
      await writeFile(join(dir, "wiki.yaml"), "id: git-lfs-docs\ntitle: Install git-lfs first\n");
      await expect(readExactConfigFile(dir, "wiki.yaml")).resolves.toEqual({
        path: "wiki.yaml",
        value: { id: "git-lfs-docs", title: "Install git-lfs first" },
      });

      await writeFile(
        join(dir, "wiki.yml"),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1\n`,
      );
      await expect(readExactConfigFile(dir, "wiki.yml")).rejects.toMatchObject({
        id: "config-read-failed",
        location: "wiki.yml",
      });
    },
  );

  test.skipIf(process.platform !== "linux")(
    "keeps the reader's diagnostics as the cause of an exact config read failure",
    async () => {
      await writeFile(join(dir, "target.yaml"), "id: docs\ntitle: Docs\n");
      await link(join(dir, "target.yaml"), join(dir, "wiki.yaml"));

      const error = await readExactConfigFile(dir, "wiki.yaml").catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        id: "config-read-failed",
        location: "wiki.yaml",
        reason: "hard-linked",
        message:
          "Configuration file could not be read safely. The file is hard-linked; replace the link with an independent copy.",
      });
      expect((error as Error).cause).toMatchObject({
        errors: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED", location: { path: "wiki.yaml" } }],
      });
      expect(Object.keys(error as object)).not.toContain("cause");
      expect(JSON.stringify(error)).not.toContain(dir);
    },
  );

  test("surfaces parse failures with file context", async () => {
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: [broken\n");

    await expect(readOptionalConfigFileWithPath(dir, ["wiki.yaml"])).rejects.toMatchObject({
      id: "config-parse-failed",
      location: "wiki.yaml",
    });
  });

  test("returns the first accessible config candidate", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(
      join(dir, "nested", "wiki.json"),
      JSON.stringify({ id: "docs", title: "Docs" }),
    );

    await expect(
      readOptionalConfigFileWithPath(join(dir, "nested"), ["wiki.yaml", "wiki.json"]),
    ).resolves.toMatchObject({ path: "wiki.json" });
  });

  test.each(PLATFORMS)("sanitizes outside config symlink errors on %s", async (platform) => {
    if (platform !== "native") vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const external = await mkdtemp(join(tmpdir(), "topik-config-secret-"));
    try {
      await writeFile(join(external, "secret.yaml"), "id: secret\ntitle: Secret\n");
      await symlink(join(external, "secret.yaml"), join(dir, "wiki.yaml"));

      await expect(readOptionalConfigFileWithPath(dir, ["wiki.yaml"])).rejects.toMatchObject({
        id: "config-read-failed",
        location: "wiki.yaml",
      });
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

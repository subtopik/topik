import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  findConfigFile,
  readConfigFile,
  readOptionalConfigFile,
  readOptionalConfigFileWithPath,
} from "./config";
import { compileGuides } from "./guide";
import { PublicCompileError } from "./public-errors";
import { compileWiki } from "./wiki";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

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

    await expect(readConfigFile(dir, ["wiki.yaml", "wiki.yml"])).resolves.toEqual({
      id: "docs",
      title: "Docs",
    });
    await expect(readOptionalConfigFileWithPath(dir, ["wiki.yaml", "wiki.yml"])).resolves.toEqual({
      path: "wiki.yml",
      value: { id: "docs", title: "Docs" },
    });
  });

  test("preserves optional and required behavior when all candidates are missing", async () => {
    const candidates = ["wiki.yaml", "wiki.yml", "wiki.json"];
    await expect(readOptionalConfigFileWithPath(dir, candidates)).resolves.toBeUndefined();
    await expect(readOptionalConfigFile(dir, candidates)).resolves.toBeUndefined();
    await expect(findConfigFile(dir, candidates)).resolves.toBeNull();
    await expect(readConfigFile(dir, candidates)).rejects.toMatchObject({ id: "config-not-found" });
  });

  test.each(["darwin", "win32"] as const)(
    "reads portable configs and preserves missing-candidate fallback on %s",
    async (platform) => {
      await writeFile(join(dir, "wiki.yml"), "id: docs\ntitle: Docs\n");
      await writeFile(join(dir, "wiki.json"), JSON.stringify({ id: "other", title: "Other" }));
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const candidates = ["wiki.yaml", "wiki.yml", "wiki.json"];

      for (const read of [readConfigFile, readOptionalConfigFile]) {
        await expect(read(dir, candidates)).resolves.toEqual({ id: "docs", title: "Docs" });
      }
      await expect(readOptionalConfigFileWithPath(dir, candidates)).resolves.toEqual({
        path: "wiki.yml",
        value: { id: "docs", title: "Docs" },
      });
      await expect(findConfigFile(dir, candidates)).resolves.toBe("wiki.yml");
      await expect(readOptionalConfigFileWithPath(dir, ["missing.yaml"])).resolves.toBeUndefined();
      await expect(readOptionalConfigFile(dir, ["missing.yaml"])).resolves.toBeUndefined();
      await expect(findConfigFile(dir, ["missing.yaml"])).resolves.toBeNull();
      await expect(readConfigFile(dir, ["missing.yaml"])).rejects.toMatchObject({
        id: "config-not-found",
      });
    },
  );

  test.each(["darwin", "win32"] as const)(
    "standalone Wiki and Guide compilers read ordinary sources on %s",
    async (platform) => {
      await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation: [intro]\n");
      await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
      const content = "# Intro\n\nSource content.\n";
      await writeFile(join(dir, "intro.md"), content);
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);

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
    "preserves unavailable procfs errors through config helpers and standalone compilers",
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
      for (const read of [
        readConfigFile,
        readOptionalConfigFile,
        readOptionalConfigFileWithPath,
        findConfigFile,
      ]) {
        await expectUnsupported(() => read(dir, ["wiki.yaml", "wiki.json"]), "wiki.yaml");
      }
      await expectUnsupported(() => compileWiki({ dir }), "wiki.yaml");
      await expectUnsupported(() => compileGuides({ dir }), "collection.yaml");
    },
  );

  async function expectUnsupported(action: () => Promise<unknown>, location: string) {
    const error: unknown = await action().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PublicCompileError);
    expect(error).toMatchObject({
      id: "file-safe-read-unsupported",
      location,
      message: "This platform cannot safely open compilation inputs.",
    });
    expect(error).not.toHaveProperty("cause");
    expect(`${String(error)}\n${JSON.stringify(error)}`).not.toContain(dir);
  }

  test("surfaces parse failures with file context", async () => {
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: [broken\n");

    await expect(readConfigFile(dir, ["wiki.yaml"])).rejects.toMatchObject({
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

    await expect(findConfigFile(join(dir, "nested"), ["wiki.yaml", "wiki.json"])).resolves.toBe(
      "wiki.json",
    );
  });

  test.each(["native", "darwin", "win32"] as const)(
    "sanitizes outside config symlink errors on %s",
    async (platform) => {
      if (platform !== "native") vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const external = await mkdtemp(join(tmpdir(), "topik-config-secret-"));
      try {
        await writeFile(join(external, "secret.yaml"), "id: secret\ntitle: Secret\n");
        await symlink(join(external, "secret.yaml"), join(dir, "wiki.yaml"));

        await expect(readConfigFile(dir, ["wiki.yaml"])).rejects.toMatchObject({
          id: "config-read-failed",
          location: "wiki.yaml",
        });
        await expect(findConfigFile(dir, ["wiki.yaml"])).rejects.toMatchObject({
          id: "config-access-failed",
          location: "wiki.yaml",
        });
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    },
  );
});

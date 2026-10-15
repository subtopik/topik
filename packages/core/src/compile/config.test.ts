import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

describe("compile config helpers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-config-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    "preserves unsupported safe-read errors through config helpers on %s",
    async (platform) => {
      await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\n");
      await writeFile(join(dir, "wiki.json"), JSON.stringify({ id: "other", title: "Other" }));
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const candidates = ["wiki.yaml", "wiki.json"];

      for (const read of [
        readConfigFile,
        readOptionalConfigFile,
        readOptionalConfigFileWithPath,
        findConfigFile,
      ]) {
        await expectUnsupported(() => read(dir, candidates), "wiki.yaml");
      }
    },
  );

  test.each(["darwin", "win32"] as const)(
    "standalone compilers report the safe-read capability failure on %s",
    async (platform) => {
      await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation: [intro]\n");
      await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
      await writeFile(join(dir, "intro.md"), "# Intro\n");
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);

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

  test("rejects config symlinks that resolve outside the compilation directory", async () => {
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
  });
});

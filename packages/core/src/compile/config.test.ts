import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { findConfigFile, readConfigFile } from "./config";

describe("compile config helpers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads the first available config file", async () => {
    await writeFile(join(dir, "wiki.yml"), "id: docs\ntitle: Docs\n");

    await expect(readConfigFile(dir, ["wiki.yaml", "wiki.yml"])).resolves.toEqual({
      id: "docs",
      title: "Docs",
    });
  });

  test("surfaces parse failures with file context", async () => {
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: [broken\n");

    await expect(readConfigFile(dir, ["wiki.yaml"])).rejects.toThrow(
      `Failed to parse config file ${join(dir, "wiki.yaml")}`,
    );
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
});

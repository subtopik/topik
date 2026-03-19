import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { compile } from "./index";

type CompileCommand = {
  handler?: (options: {
    dir: string;
    outDir?: string;
    format: "json" | "jsonl" | "yaml";
    dryRun: boolean;
    clean: boolean;
    validate: boolean;
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
      }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith("WikiPage/docs-intro.json");
    expect(log).toHaveBeenCalledWith("Wiki/docs.json");
  });
});

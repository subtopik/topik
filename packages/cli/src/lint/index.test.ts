import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { CliError } from "../errors";
import { lint } from "./index";

type LintCommand = {
  handler?: (options: { dir: string; links: "error" | "warning" | "off" }) => Promise<void>;
};

describe("lint command", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-lint-"));
    await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  test("passes valid source content without writing output", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Section](#section)\n\n## Section\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect((lint as LintCommand).handler?.({ dir, links: "error" })).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith("Lint passed");
  });

  test("fails for unresolved links in error mode", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Missing](/missing)\n");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect((lint as LintCommand).handler?.({ dir, links: "error" })).rejects.toBeInstanceOf(
      CliError,
    );
  });

  test("reports unresolved links as warnings when configured", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Missing](/missing)\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      (lint as LintCommand).handler?.({ dir, links: "warning" }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("link-page-not-found"));
    expect(log).toHaveBeenCalledWith("Lint passed with 1 warning(s)");
  });
});

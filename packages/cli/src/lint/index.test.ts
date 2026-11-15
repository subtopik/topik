import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { CliError } from "../errors";
import { lint, lintJsonReport } from "./index";

type LintCommand = {
  handler?: (options: {
    dir: string;
    links: "error" | "warning" | "off";
    json?: boolean;
  }) => Promise<void>;
};

describe("lint command", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-lint-"));
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "cli-lint-fixture",
        sources: [{ kind: "wiki", config: "wiki.yaml" }],
      }),
    );
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

  test("--json prints one report on stdout and keeps the failing exit", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Missing](/missing)\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      (lint as LintCommand).handler?.({ dir, links: "error", json: true }),
    ).rejects.toMatchObject({ id: "lint-failed" });

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      diagnostics: [
        {
          file: "intro.md",
          line: 3,
          lines: [3],
          id: "link-page-not-found",
          severity: "error",
          message: "Internal link target page was not found.",
        },
      ],
      errors: 1,
      warnings: 0,
    });
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("--json reports warnings and passes", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Missing](/missing)\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      (lint as LintCommand).handler?.({ dir, links: "warning", json: true }),
    ).resolves.toBeUndefined();

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [{ id: "link-page-not-found", severity: "warning" }],
      errors: 0,
      warnings: 1,
    });
  });

  test("lintJsonReport keeps the column and omits unknown fields", () => {
    expect(
      lintJsonReport([
        {
          id: "parse-error",
          type: "document",
          level: "critical",
          message: "",
          lines: [2],
          column: 5,
        },
        { id: "parse-error", type: "document", level: "error", message: "", lines: [] },
      ]).diagnostics,
    ).toEqual([
      {
        line: 2,
        lines: [2],
        column: 5,
        id: "parse-error",
        severity: "critical",
        message: "Content could not be parsed.",
      },
      { lines: [], id: "parse-error", severity: "error", message: "Content could not be parsed." },
    ]);
  });
});

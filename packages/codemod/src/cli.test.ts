import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import packageJson from "../package.json";
import { runMintlify } from "./runner";

const execFileAsync = promisify(execFile);
const builtCli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

const runMock = vi.hoisted(() => vi.fn());
vi.mock("@drizzle-team/brocli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@drizzle-team/brocli")>()),
  run: runMock,
}));
vi.mock("./runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner")>();
  return { ...actual, runMintlify: vi.fn(actual.runMintlify) };
});

describe("codemod CLI file results", () => {
  let dir: string;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-codemod-cli-"));
    process.exitCode = undefined;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    process.exitCode = originalExitCode;
  });

  async function runCli(dryRun = false) {
    runMock.mockImplementationOnce(async ([command]) => {
      await command.handler({ dir, dryRun, keepExtension: false });
    });
    await import("./cli");
  }

  test.each([false, true])(
    "reports collisions and processes other files (dry run: %s)",
    async (dryRun) => {
      await writeFile(join(dir, "blocked.md"), "# Existing\n");
      await writeFile(join(dir, "blocked.mdx"), "# Source\n");
      await writeFile(join(dir, "good.mdx"), "<Note>Good.</Note>\n");

      await runCli(dryRun);

      expect(console.error).toHaveBeenCalledWith(
        "✗ blocked.mdx — Skipping rename: destination blocked.md already exists",
      );
      expect(console.error).toHaveBeenCalledWith("✗ 1 file(s) failed");
      expect(console.log).toHaveBeenCalledWith("  skipped blocked.mdx (error)");
      expect(console.log).toHaveBeenCalledWith(
        `  ${dryRun ? "would convert" : "converted"} good.mdx → good.md`,
      );
      expect(console.log).toHaveBeenCalledWith(
        `${dryRun ? "would convert" : "converted"} 1 file(s)`,
      );
      expect(process.exitCode).toBe(1);
      expect(await readFile(join(dir, "blocked.md"), "utf-8")).toBe("# Existing\n");
      expect(await readFile(join(dir, "blocked.mdx"), "utf-8")).toBe("# Source\n");
      if (dryRun) {
        expect(await readFile(join(dir, "good.mdx"), "utf-8")).toBe("<Note>Good.</Note>\n");
        expect(await readdir(dir)).not.toContain("good.md");
      } else {
        expect(await readFile(join(dir, "good.md"), "utf-8")).toContain(
          '{% callout variant="info" %}',
        );
        expect(await readdir(dir)).not.toContain("good.mdx");
      }
    },
  );

  test("reports caught I/O errors and counts each failed file", async () => {
    vi.mocked(runMintlify).mockResolvedValueOnce({
      files: [
        {
          relativePath: "read.mdx",
          changed: false,
          contentChanged: false,
          warnings: [],
          error: "Unable to read file",
        },
        {
          relativePath: "write.mdx",
          changed: false,
          contentChanged: false,
          warnings: [],
          error: "Unable to write file",
        },
      ],
      filesChanged: 0,
      warnings: 0,
      notices: [],
    });

    await runCli();

    expect(console.error).toHaveBeenCalledWith("✗ read.mdx — Unable to read file");
    expect(console.error).toHaveBeenCalledWith("✗ write.mdx — Unable to write file");
    expect(console.error).toHaveBeenCalledWith("✗ 2 file(s) failed");
    expect(process.exitCode).toBe(1);
  });

  test("keeps warning-only and successful runs successful", async () => {
    await writeFile(join(dir, "unsupported.mdx"), '<Icon icon="star" />\n');
    await writeFile(join(dir, "good.mdx"), "<Note>Good.</Note>\n");

    await runCli();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("unsupported.mdx:1:1"));
    expect(console.log).toHaveBeenCalledWith("✓ converted 1 file(s)");
    expect(console.log).toHaveBeenCalledWith("⚠ 1 warning(s)");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^ℹ Kept .mdx extensions on 1 file\(s\)/),
    );
    expect(process.exitCode).toBeUndefined();
  });

  test.each([false, true])("lists each file's outcome (dry run: %s)", async (dryRun) => {
    await writeFile(join(dir, "converted.mdx"), "<Note>Good.</Note>\n");
    await writeFile(join(dir, "plain.mdx"), "# Plain\n");
    await writeFile(join(dir, "kept.md"), "# Kept\n");
    await writeFile(join(dir, "edited.md"), "<Tip>Edited.</Tip>\n");

    await runCli(dryRun);

    const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
    expect(lines).toEqual(
      expect.arrayContaining([
        `  ${dryRun ? "would convert" : "converted"} converted.mdx → converted.md`,
        `  ${dryRun ? "would rename" : "renamed"} plain.mdx → plain.md`,
        `  ${dryRun ? "would convert" : "converted"} edited.md`,
        `✓ ${dryRun ? "would convert" : "converted"} 3 file(s)`,
      ]),
    );
    expect(lines.some((line) => String(line).includes("kept.md"))).toBe(false);
  });

  test("passes the package version to brocli", async () => {
    await runCli(true);
    expect(runMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ name: "topik-codemod", version: packageJson.version }),
    );
  });

  test("prints only the patch on stdout with --diff and writes nothing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await writeFile(join(dir, "good.mdx"), "<Note>Good.</Note>\n");
    await writeFile(
      join(dir, "docs.json"),
      JSON.stringify({ name: "Docs", navigation: { pages: ["good"] } }),
    );
    runMock.mockImplementationOnce(async ([command]) => {
      await command.handler({ dir, dryRun: false, keepExtension: false, diff: true });
    });
    await import("./cli");

    const patch = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(patch).toBe(
      [
        "--- a/good.mdx",
        "+++ b/good.md",
        "@@ -1,1 +1,3 @@",
        "-<Note>Good.</Note>",
        '+{% callout variant="info" %}',
        "+Good.",
        "+{% /callout %}",
        "--- /dev/null",
        "+++ b/wiki.yaml",
        "@@ -0,0 +1,4 @@",
        "+id: docs",
        "+title: Docs",
        "+navigation:",
        "+  - good",
        "",
      ].join("\n"),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("  would convert good.mdx → good.md");
    expect(console.error).toHaveBeenCalledWith("  would write wiki.yaml from docs.json");
    expect(console.error).toHaveBeenCalledWith("✓ would convert 1 file(s)");
    expect((await readdir(dir)).sort()).toEqual(["docs.json", "good.mdx"]);
  });

  test("reports navigation warnings against the Mintlify configuration", async () => {
    await writeFile(join(dir, "good.mdx"), "# Good\n");
    await writeFile(
      join(dir, "docs.json"),
      JSON.stringify({ name: "Docs", navigation: { pages: ["good", "gone"] } }),
    );

    await runCli();

    expect(console.log).toHaveBeenCalledWith("  wrote wiki.yaml from docs.json");
    expect(console.error).toHaveBeenCalledWith(
      '⚠ docs.json — navigation.pages[1]: page "gone" has no .md or .mdx file in the directory; not converted',
    );
    expect(console.log).toHaveBeenCalledWith("⚠ 1 warning(s)");
    expect(process.exitCode).toBeUndefined();
  });

  test("rejects a path that is neither a directory nor a Markdown file", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await writeFile(join(dir, "notes.txt"), "text\n");
    runMock.mockImplementationOnce(async ([command]) => {
      await expect(
        command.handler({ dir: join(dir, "notes.txt"), dryRun: false, keepExtension: false }),
      ).rejects.toThrow("exit");
    });
    await import("./cli");

    expect(console.error).toHaveBeenCalledWith("Not a directory or a .md or .mdx file");
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("lists skipped files with their warning count", async () => {
    await writeFile(join(dir, "unsupported.md"), '<Icon icon="star" />\n');

    await runCli(true);

    expect(console.log).toHaveBeenCalledWith("  skipped unsupported.md (1 warning(s))");
  });
});

describe.skipIf(!existsSync(builtCli))("built topik-codemod binary", () => {
  test.each([["--version"], ["-v"]])("prints the package version for %s", async (flag) => {
    const { stdout } = await execFileAsync(process.execPath, [builtCli, flag]);
    expect(stdout).toBe(`${packageJson.version}\n`);
  });
});

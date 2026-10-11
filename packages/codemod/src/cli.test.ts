import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { runMintlify } from "./runner";

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
        { relativePath: "read.mdx", changed: false, warnings: [], error: "Unable to read file" },
        { relativePath: "write.mdx", changed: false, warnings: [], error: "Unable to write file" },
      ],
      filesChanged: 0,
      warnings: 0,
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
    expect(process.exitCode).toBeUndefined();
  });
});

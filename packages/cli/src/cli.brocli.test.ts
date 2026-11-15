import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { command } from "@drizzle-team/brocli";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import packageJson from "../package.json";

const SENTINEL = "PRIVATE_VALUE";
const execFileAsync = promisify(execFile);
const builtCli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

// Keep real brocli: only replace one command with a handler that fails like a raw
// Node.js filesystem or socket error.
vi.mock("./validate", () => ({
  validate: command({
    name: "validate",
    handler: () => {
      throw new Error(`ENOENT: no such file or directory, open '/tmp/${SENTINEL}/x.json'`);
    },
  }),
}));

describe("cli entrypoint with real brocli", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test("prints sanitized handler failures and exits 1", async () => {
    const output: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values) => {
      output.push(values.map(String).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    process.argv = ["node", "topik", "validate"];

    await import("./cli");

    expect(output).toEqual(["Topik command failed."]);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe.skipIf(!existsSync(builtCli))("built topik binary", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function runBuilt(args: string[], prependCli = true) {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        prependCli ? [builtCli, ...args] : args,
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
    }
  }

  test.each([["--version"], ["-v"]])("prints the package version for %s", async (flag) => {
    const result = await runBuilt([flag]);
    expect(result).toMatchObject({ code: 0, stdout: `${packageJson.version}\n` });
  });

  test("keeps machine paths out of handler failures", async () => {
    dir = await mkdtemp(join(tmpdir(), `topik-cli-bin-${SENTINEL}-`));
    await writeFile(join(dir, "file"), "not a directory");

    const result = await runBuilt(["compile", dir, "--out-dir", join(dir, "file", "out")]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("Topik command failed.\n");
  });

  test("prints located content diagnostics when compilation fails", async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-bin-"));
    await writeFile(
      join(dir, ".topik.yaml"),
      "version: 1\nnamespace: a/b\nsources:\n  - kind: wiki\n    config: wiki.yaml\n",
    );
    await writeFile(join(dir, "wiki.yaml"), "id: w\ntitle: W\nnavigation: [index]\n");
    await writeFile(join(dir, "index.md"), "# Index\n\n[missing](./missing.md)\n");

    const result = await runBuilt(["compile", dir, "--dry-run"]);

    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      stderr:
        "index.md:3 error link-page-not-found: Internal link target page was not found.\n" +
        "1 compile error(s)\n" +
        "Compilation found errors.\n",
    });
  });

  describe.each(["darwin", "win32"])("on %s", (platform) => {
    const PLATFORM_REQUIREMENT =
      "topik compile, lint and dev currently require Linux, because this platform cannot read project files safely. Run them on Linux, for example in WSL 2 or a Linux container; topik validate works on any platform.\n";
    // Preloaded before the CLI so every platform check in core and the CLI sees it.
    const simulatePlatform = `--import=data:text/javascript,Object.defineProperty(process,"platform",{value:"${platform}"})`;

    async function runOnPlatform(args: string[]) {
      return runBuilt([simulatePlatform, builtCli, ...args], false);
    }

    async function project(): Promise<string> {
      dir = await mkdtemp(join(tmpdir(), "topik-cli-platform-"));
      await writeFile(
        join(dir, ".topik.yaml"),
        "version: 1\nnamespace: a/b\nsources:\n  - kind: wiki\n    config: wiki.yaml\n",
      );
      await writeFile(join(dir, "wiki.yaml"), "id: w\ntitle: W\nnavigation: [index]\n");
      await writeFile(join(dir, "index.md"), "# Index\n");
      return dir;
    }

    test.each([
      ["compile --dry-run", (source: string) => ["compile", source, "--dry-run"]],
      ["compile", (source: string) => ["compile", source, "--out-dir", join(source, "out")]],
      ["lint", (source: string) => ["lint", source]],
    ])("%s fails with the platform requirement", async (_name, args) => {
      const source = await project();

      const result = await runOnPlatform(args(source));

      expect(result).toMatchObject({ code: 1, stdout: "", stderr: PLATFORM_REQUIREMENT });
    });

    test("dev stops with the platform requirement instead of serving", async () => {
      const result = await runOnPlatform(["dev", await project(), "--port", "0"]);

      expect(result).toMatchObject({
        code: 1,
        stdout: "Watching content for changes...\n",
        stderr: PLATFORM_REQUIREMENT,
      });
    });

    test("validate still works", async () => {
      dir = await mkdtemp(join(tmpdir(), "topik-cli-platform-"));
      await writeFile(
        join(dir, "wiki.json"),
        JSON.stringify({
          apiVersion: "v1",
          type: "Wiki",
          name: "w",
          spec: {
            title: "W",
            navigation: [{ type: "page", page: "w-index", slug: "", sourcePath: "index" }],
          },
        }),
      );

      const result = await runOnPlatform(["validate", dir]);

      expect(result).toMatchObject({ code: 0, stdout: "Validated 1 resources\n", stderr: "" });
    });
  });

  test("help states which commands require Linux", async () => {
    const result = await runBuilt(["--help"]);

    expect(result.stdout).toContain(
      "compile    Compile project content into Topik resource files. Requires Linux.\n",
    );
    expect(result.stdout).toContain(
      "dev        Start a development server that watches for content changes. Requires Linux.\n",
    );
    expect(result.stdout).toContain(
      "lint       Lint Topik source content without writing compiled resources. Requires Linux.\n",
    );
    expect(result.stdout).toContain(
      "validate   Validate Topik resource files in JSON, JSONL, or YAML format against schemas\n",
    );
    for (const [command, summary] of [
      ["compile", "Compile project content into Topik resource files. Requires Linux."],
      ["dev", "Start a development server that watches for content changes. Requires Linux."],
      ["lint", "Lint Topik source content without writing compiled resources. Requires Linux."],
    ]) {
      expect((await runBuilt([command, "--help"])).stdout.split("\n")[1]).toBe(summary);
    }
  });

  test("rejects a malformed dev port before compiling", async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-bin-"));

    const result = await runBuilt(["dev", dir, "--port", "50001abc"]);

    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Dev server port must be an integer from 0 to 65535.\n",
    });
  });
});

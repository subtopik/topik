import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { command } from "@drizzle-team/brocli";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import packageJson from "../package.json";
import { PORTABLE_READS_NOTICE } from "./file-safety";

const SENTINEL = "PRIVATE_VALUE";
const execFileAsync = promisify(execFile);
const builtCli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
/** What a project-reading command prints on stderr before its own output on this platform. */
const NATIVE_NOTICE = process.platform === "linux" ? "" : `${PORTABLE_READS_NOTICE}\n`;
// A preloaded process.platform cannot make one host's filesystem behave like another's, so
// both portable platforms are simulated on Linux only; elsewhere the native one runs for real.
const PORTABLE_PLATFORMS = process.platform === "linux" ? ["darwin", "win32"] : [process.platform];

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
    expect(result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain(tmpdir());
    // POSIX reports ENOTDIR for a path below a regular file, which stops the output scope
    // check with its fixed message. Windows reports ENOENT, the same as an output directory
    // that does not exist yet, so the command goes on to read the project and fails there.
    expect(result.stderr).toBe(
      process.platform === "win32"
        ? `${NATIVE_NOTICE}.topik.yaml: Project compilation requires .topik.yaml in the selected directory. Add a manifest such as: {"version":1,"namespace":"owner/project","sources":[{"kind":"wiki","config":"wiki.yaml"}]}\n`
        : "Compilation output path could not be resolved to prove it is outside the source directory.\n",
    );
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
        NATIVE_NOTICE +
        "index.md:3 error link-page-not-found: Internal link target page was not found.\n" +
        "1 compile error(s)\n" +
        "Compilation found errors.\n",
    });
  });

  describe.each(PORTABLE_PLATFORMS)("on %s", (platform) => {
    const PLATFORM_REQUIREMENT =
      "--file-safety anchored requires descriptor-anchored file reads, which only Linux provides. Use --file-safety portable on a workspace you trust, or run on Linux, for example in WSL 2 or a Linux container.\n";
    const PORTABLE_NOTICE =
      "Note: this platform cannot anchor file access to the project directory, so topik checks paths and file identity instead. Use it only on a workspace you trust; pass --file-safety anchored to refuse.\n";
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
      await writeFile(join(dir, "index.md"), "# Index\n\n[Guide](./guide.pdf)\n");
      await writeFile(join(dir, "guide.pdf"), "%PDF-1.4\n%%EOF\n");
      return dir;
    }

    test("compile --dry-run reads the project with one notice", async () => {
      const result = await runOnPlatform(["compile", await project(), "--dry-run"]);

      expect(result).toMatchObject({ code: 0, stderr: PORTABLE_NOTICE });
      expect(result.stdout).toContain("3 resources and 1 payloads (dry run)\n");
    });

    test("compile publishes and replaces its own output", async () => {
      const source = await project();
      const out = join(source, "out");

      for (let run = 0; run < 2; run++) {
        const result = await runOnPlatform(["compile", source, "--out-dir", out]);
        expect(result).toMatchObject({ code: 0, stderr: PORTABLE_NOTICE });
        expect(result.stdout).toMatch(/^Compiled 3 resources and 1 payloads to /u);
      }
      expect(JSON.parse(await readFile(join(out, "semantic.json"), "utf8"))).toBeTypeOf("object");
      expect(
        (await readdir(source)).filter((name) => name.startsWith(".topik-compilation")),
      ).toEqual([]);
    });

    test("compile refuses to replace a directory it does not own", async () => {
      const source = await project();
      const out = join(source, "out");
      await mkdir(out);
      await writeFile(join(out, "keep.txt"), "mine\n");

      const result = await runOnPlatform(["compile", source, "--out-dir", out]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "Existing compilation output is populated but is not recognized as owned.",
      );
      expect(await readFile(join(out, "keep.txt"), "utf8")).toBe("mine\n");
    });

    test("lint passes with one notice", async () => {
      const result = await runOnPlatform(["lint", await project()]);

      expect(result).toMatchObject({ code: 0, stdout: "Lint passed\n", stderr: PORTABLE_NOTICE });
    });

    test("format --check reads with one notice", async () => {
      const result = await runOnPlatform(["format", await project(), "--check"]);

      expect(result).toMatchObject({
        code: 0,
        stdout: "All 1 file(s) are formatted\n",
        stderr: PORTABLE_NOTICE,
      });
    });

    test("format rewrites a file with one notice", async () => {
      const source = await project();
      await writeFile(join(source, "index.md"), "# Index\n\n- a\n* b\n");

      const result = await runOnPlatform(["format", source]);

      expect(result).toMatchObject({
        code: 0,
        stdout: "index.md\nFormatted 1 of 1 file(s)\n",
        stderr: PORTABLE_NOTICE,
      });
      expect(await readFile(join(source, "index.md"), "utf8")).toBe("# Index\n\n- a\n\n* b\n");
    });

    test("dev serves with one notice", async () => {
      const source = await project();
      const child = spawn(
        process.execPath,
        [simulatePlatform, builtCli, "dev", source, "--port", "0"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      try {
        await new Promise<void>((resolveListening, reject) => {
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
            if (stdout.includes("Dev server listening on http://localhost:")) resolveListening();
          });
          child.on("exit", (code) => reject(new Error(`dev exited with ${code}: ${stderr}`)));
        });
      } finally {
        child.kill("SIGTERM");
      }
      expect(stdout).toContain("Compiled 3 resources\n");
      expect(stderr).toBe(PORTABLE_NOTICE);
    });

    test.each([
      ["compile --dry-run", (source: string) => ["compile", source, "--dry-run"]],
      ["compile", (source: string) => ["compile", source, "--out-dir", join(source, "out")]],
      ["lint", (source: string) => ["lint", source]],
      ["format", (source: string) => ["format", source]],
    ])("%s --file-safety anchored fails with the platform requirement", async (_name, args) => {
      const source = await project();

      const result = await runOnPlatform([...args(source), "--file-safety", "anchored"]);

      expect(result).toMatchObject({ code: 1, stdout: "", stderr: PLATFORM_REQUIREMENT });
    });

    test("dev --file-safety anchored stops with the platform requirement", async () => {
      const result = await runOnPlatform([
        "dev",
        await project(),
        "--port",
        "0",
        "--file-safety",
        "anchored",
      ]);

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

  // --file-safety is documented to have no effect on Linux; the other platforms print the notice.
  test.skipIf(process.platform !== "linux")("Linux prints no portable-read notice", async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-linux-"));
    await writeFile(
      join(dir, ".topik.yaml"),
      "version: 1\nnamespace: a/b\nsources:\n  - kind: wiki\n    config: wiki.yaml\n",
    );
    await writeFile(join(dir, "wiki.yaml"), "id: w\ntitle: W\nnavigation: [index]\n");
    await writeFile(join(dir, "index.md"), "# Index\n");

    const result = await runBuilt(["lint", dir, "--file-safety", "portable"]);

    expect(result).toMatchObject({ code: 0, stdout: "Lint passed\n", stderr: "" });
  });

  test("help offers --file-safety on project commands", async () => {
    const result = await runBuilt(["--help"]);

    expect(result.stdout).toContain(
      "compile    Compile project content into Topik resource files\n",
    );
    expect(result.stdout).not.toContain("Requires Linux");
    for (const command of ["compile", "dev", "format", "lint"]) {
      expect((await runBuilt([command, "--help"])).stdout).toMatch(
        /--file-safety \[ portable \| anchored \] +How project files are read where descriptor-anchored reads are unavailable \(macOS, Windows\): .* \(default: "portable"\)\n/u,
      );
    }
  });

  test("init scaffolds a project that compiles with --validate and is formatted", async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-init-"));
    const project = join(dir, "handbook");

    expect(await runBuilt(["init", project])).toMatchObject({
      code: 0,
      stdout:
        "Created .topik.yaml, wiki.yaml, index.md, AGENTS.md\n" +
        "Next: run topik compile --validate in the project directory\n",
      stderr: "",
    });
    const compiled = await runBuilt(["compile", project, "--validate"]);
    expect(compiled).toMatchObject({ code: 0, stderr: NATIVE_NOTICE });
    expect(compiled.stdout).toMatch(/^Compiled 2 resources and 0 payloads to /u);
    // A repository readme is not project content: format leaves it alone.
    await writeFile(join(project, "README.md"), "<p align=center>Repository readme</p>\n");
    expect(await runBuilt(["format", project, "--check"])).toMatchObject({
      code: 0,
      stdout: "All 1 file(s) are formatted\n",
      stderr: NATIVE_NOTICE,
    });
    expect(await runBuilt(["migrate", project])).toMatchObject({
      code: 0,
      stdout: "AGENTS.md is up to date\n",
      stderr: "",
    });
    expect(await runBuilt(["init", project])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Project files already exist. topik init does not overwrite files.\n",
    });
    expect(await runBuilt(["migrate", dir])).toMatchObject({
      code: 1,
      stdout: "",
      stderr:
        "topik migrate requires .topik.yaml in the selected directory. Run topik init to create a project.\n",
    });
  });

  test("lint --json prints only the report on stdout", async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-bin-"));
    await writeFile(
      join(dir, ".topik.yaml"),
      "version: 1\nnamespace: a/b\nsources:\n  - kind: wiki\n    config: wiki.yaml\n",
    );
    await writeFile(join(dir, "wiki.yaml"), "id: w\ntitle: W\nnavigation: [index]\n");
    await writeFile(join(dir, "index.md"), "# Index\n\n[missing](./missing.md)\n");

    const result = await runBuilt(["lint", dir, "--json"]);

    expect(result).toMatchObject({ code: 1, stderr: `${NATIVE_NOTICE}Lint found errors.\n` });
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: [
        {
          file: "index.md",
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

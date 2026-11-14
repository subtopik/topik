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

  async function runBuilt(args: string[]) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [builtCli, ...args]);
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

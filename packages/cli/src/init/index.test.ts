import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { AGENT_INSTRUCTIONS } from "../agents";
import { compile } from "../compile";
import { PublicCliError } from "../errors";
import { runFormat } from "../format";
import { init } from "./index";

type InitCommand = {
  handler?: (options: { dir: string; namespace: string }) => Promise<void>;
};

type CompileCommand = {
  handler?: (options: {
    dir: string;
    format: "json";
    dryRun: boolean;
    validate: boolean;
    links: "error" | "warning" | "off";
  }) => Promise<void>;
};

async function runInit(dir: string, namespace = "example/handbook"): Promise<void> {
  await (init as InitCommand).handler?.({ dir, namespace });
}

describe("init command", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-init-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the docs example project, which compiles with --validate", async () => {
    await runInit(dir);

    expect(await readFile(join(dir, ".topik.yaml"), "utf8")).toBe(
      "version: 1\nnamespace: example/handbook\nsources:\n  - kind: wiki\n    config: wiki.yaml\n",
    );
    expect(await readFile(join(dir, "wiki.yaml"), "utf8")).toBe(
      "id: handbook\ntitle: Handbook\nnavigation:\n  - index\n",
    );
    expect(await readFile(join(dir, "index.md"), "utf8")).toMatch(/^# Handbook\n\n/u);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(AGENT_INSTRUCTIONS);
    expect(console.log).toHaveBeenCalledWith("Created .topik.yaml, wiki.yaml, index.md, AGENTS.md");

    await expect(
      (compile as CompileCommand).handler?.({
        dir,
        format: "json",
        dryRun: false,
        validate: true,
        links: "error",
      }),
    ).resolves.toBeUndefined();
    expect(await readdir(join(dir, ".topik", "resources"))).toEqual(["Wiki", "WikiPage"]);
  });

  test("writes a page that is already formatted", async () => {
    await runInit(dir);

    await expect(
      runFormat(join(dir, "index.md"), { check: true, fileSafety: "portable" }),
    ).resolves.toBeUndefined();
  });

  test("leaves AGENTS.md out when a directory is formatted", async () => {
    await runInit(dir);

    await expect(runFormat(dir, { check: true, fileSafety: "portable" })).resolves.toBeUndefined();
  });

  test("keeps an existing AGENTS.md without a Topik section", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# House rules\n");

    await runInit(dir);

    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("# House rules\n");
    expect(console.log).toHaveBeenCalledWith("Created .topik.yaml, wiki.yaml, index.md");
  });

  test("updates the Topik section of an existing AGENTS.md and keeps the rest", async () => {
    const before = "# House rules\n\n<!--TOPIK START-->\nold\n<!--TOPIK END-->\n\nMore rules\n";
    await writeFile(join(dir, "AGENTS.md"), before);

    await runInit(dir);

    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(
      `# House rules\n\n${AGENT_INSTRUCTIONS.trimEnd()}\n\nMore rules\n`,
    );
    expect(console.log).toHaveBeenCalledWith("Created .topik.yaml, wiki.yaml, index.md");
  });

  test("does not follow an AGENTS.md that is a symbolic link", async () => {
    await writeFile(join(dir, "elsewhere.md"), "<!--TOPIK START-->\nold\n<!--TOPIK END-->\n");
    await symlink(join(dir, "elsewhere.md"), join(dir, "AGENTS.md"));

    await runInit(dir);

    expect(await readFile(join(dir, "elsewhere.md"), "utf8")).toBe(
      "<!--TOPIK START-->\nold\n<!--TOPIK END-->\n",
    );
  });

  test("uses --namespace and creates a missing directory", async () => {
    const target = join(dir, "nested", "docs");
    await runInit(target, "acme/docs");

    expect(await readFile(join(target, ".topik.yaml"), "utf8")).toContain("namespace: acme/docs\n");
  });

  test("rejects an invalid namespace without writing", async () => {
    await expect(runInit(dir, " padded ")).rejects.toMatchObject({
      id: "init-namespace-invalid",
    });
    expect(await readdir(dir)).toEqual([]);
  });

  test.each([".topik.yaml", "wiki.yaml", "index.md"])(
    "refuses to overwrite an existing %s and writes nothing",
    async (name) => {
      await writeFile(join(dir, name), "mine\n");

      const failure = runInit(dir);
      await expect(failure).rejects.toBeInstanceOf(PublicCliError);
      await expect(failure).rejects.toMatchObject({ id: "init-file-exists" });
      expect(await readdir(dir)).toEqual([name]);
      expect(await readFile(join(dir, name), "utf8")).toBe("mine\n");
    },
  );

  test("treats a dangling symbolic link as an existing file", async () => {
    await symlink(join(dir, "elsewhere.md"), join(dir, "index.md"));

    await expect(runInit(dir)).rejects.toMatchObject({ id: "init-file-exists" });
    expect((await readdir(dir)).sort()).toEqual(["index.md"]);
  });

  test("fails when the target is a file", async () => {
    await writeFile(join(dir, "file"), "x");

    await expect(runInit(join(dir, "file"))).rejects.toMatchObject({
      id: "init-target-access-failed",
    });
  });
});

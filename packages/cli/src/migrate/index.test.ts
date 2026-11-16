import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_END_MARKER,
  AGENT_INSTRUCTIONS_START_MARKER,
  replaceAgentInstructionsSection,
} from "../agents";
import { initProject } from "../init";
import { migrate, migrateProject } from "./index";

type MigrateCommand = { handler?: (options: { dir: string }) => Promise<void> };

const OLD_SECTION = `${AGENT_INSTRUCTIONS_START_MARKER}\nold\n${AGENT_INSTRUCTIONS_END_MARKER}`;

describe("migrate command", () => {
  let dir: string;
  let agents: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-migrate-"));
    agents = join(dir, "AGENTS.md");
    await writeFile(join(dir, ".topik.yaml"), "version: 1\nnamespace: a/b\nsources: []\n");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  test("creates AGENTS.md when the project has none, then changes nothing", async () => {
    await (migrate as MigrateCommand).handler?.({ dir });
    expect(console.log).toHaveBeenLastCalledWith("Created AGENTS.md");
    expect(await readFile(agents, "utf8")).toBe(AGENT_INSTRUCTIONS);

    const written = await stat(agents);
    await (migrate as MigrateCommand).handler?.({ dir });
    expect(console.log).toHaveBeenLastCalledWith("AGENTS.md is up to date");
    expect((await stat(agents)).mtimeMs).toBe(written.mtimeMs);
  });

  test("changes nothing right after init", async () => {
    const project = join(dir, "project");
    await initProject(project);

    expect(await migrateProject(project)).toBe("unchanged");
  });

  test.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("replaces only the marked section in a %s file", async (_label, eol) => {
    const before = `# House rules${eol}${eol}`;
    const after = `${eol}${eol}More rules${eol}`;
    await writeFile(agents, before + OLD_SECTION + after);

    await (migrate as MigrateCommand).handler?.({ dir });

    expect(console.log).toHaveBeenLastCalledWith("Updated the Topik section of AGENTS.md");
    expect(await readFile(agents, "utf8")).toBe(before + AGENT_INSTRUCTIONS.trimEnd() + after);
    expect(await migrateProject(dir)).toBe("unchanged");
  });

  test.each([
    ["no markers", "# House rules\n"],
    ["a start marker without an end", `${AGENT_INSTRUCTIONS_START_MARKER}\nold\n`],
    ["an end marker before the start", `${AGENT_INSTRUCTIONS_END_MARKER}\n${OLD_SECTION}\n`],
    ["two sections", `${OLD_SECTION}\n${OLD_SECTION}\n`],
  ])("keeps a file with %s", async (_label, content) => {
    await writeFile(agents, content);

    expect(await migrateProject(dir)).toBe("kept");
    expect(await readFile(agents, "utf8")).toBe(content);
  });

  test("keeps a file that is not valid UTF-8", async () => {
    const content = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${OLD_SECTION}\n`)]);
    await writeFile(agents, content);

    expect(await migrateProject(dir)).toBe("kept");
    expect((await readFile(agents)).equals(content)).toBe(true);
  });

  test("does not follow an AGENTS.md that is a symbolic link", async () => {
    await writeFile(join(dir, "elsewhere.md"), `${OLD_SECTION}\n`);
    await symlink(join(dir, "elsewhere.md"), agents);

    expect(await migrateProject(dir)).toBe("kept");
    expect(await readFile(join(dir, "elsewhere.md"), "utf8")).toBe(`${OLD_SECTION}\n`);
  });

  test("requires a project manifest and writes nothing without one", async () => {
    await rm(join(dir, ".topik.yaml"));

    await expect(migrateProject(dir)).rejects.toMatchObject({ id: "migrate-project-missing" });
    await expect(stat(agents)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("agent instructions section", () => {
  test("is a single marked section that replacing leaves as it is", () => {
    expect(AGENT_INSTRUCTIONS.startsWith(AGENT_INSTRUCTIONS_START_MARKER)).toBe(true);
    expect(AGENT_INSTRUCTIONS.endsWith(`${AGENT_INSTRUCTIONS_END_MARKER}\n`)).toBe(true);
    expect(replaceAgentInstructionsSection(AGENT_INSTRUCTIONS)).toBe(AGENT_INSTRUCTIONS);
  });
});

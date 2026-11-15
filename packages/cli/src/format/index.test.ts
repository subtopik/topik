import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatTopikContent } from "@topik/content";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { discoverFormatTargets, runFormat } from "./index";

const UNFORMATTED = "# Title\n\n- one\n* two\n";
const FORMATTED = "# Title\n\n- one\n\n* two\n";

describe("format command", () => {
  let dir: string;
  let log: string[];
  let errors: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-cli-format-"));
    log = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...values) => {
      log.push(values.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...values) => {
      errors.push(values.map(String).join(" "));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const run = (path: string, check = false) => runFormat(path, { check, fileSafety: "portable" });

  test("uses the content formatter's canonical output", () => {
    expect(formatTopikContent(UNFORMATTED)).toMatchObject({ ok: true, formatted: FORMATTED });
  });

  test("discovers .md and .mdx files, skipping node_modules, dot-directories and links", async () => {
    await mkdir(join(dir, "guide", "deep"), { recursive: true });
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, ".topik"));
    await writeFile(join(dir, "index.md"), FORMATTED);
    await writeFile(join(dir, "guide", "deep", "page.mdx"), FORMATTED);
    await writeFile(join(dir, "wiki.yaml"), "id: w\n");
    await writeFile(join(dir, "node_modules", "skip.md"), UNFORMATTED);
    await writeFile(join(dir, ".topik", "skip.md"), UNFORMATTED);
    await symlink(join(dir, "index.md"), join(dir, "link.md"));
    await symlink(join(dir, "guide"), join(dir, "linked-dir"));

    const targets = await discoverFormatTargets(dir);

    expect(targets.map(({ path, label }) => [path, label])).toEqual([
      ["guide/deep/page.mdx", "guide/deep/page.mdx"],
      ["index.md", "index.md"],
    ]);
    expect(targets.every(({ root }) => root === dir)).toBe(true);
  });

  test("rewrites unformatted files in place and keeps their mode", async () => {
    await mkdir(join(dir, "guide"));
    await writeFile(join(dir, "index.md"), FORMATTED);
    await writeFile(join(dir, "guide", "page.md"), UNFORMATTED);
    await chmod(join(dir, "guide", "page.md"), 0o640);

    await expect(run(dir)).resolves.toBeUndefined();

    expect(await readFile(join(dir, "guide", "page.md"), "utf8")).toBe(FORMATTED);
    expect((await stat(join(dir, "guide", "page.md"))).mode & 0o777).toBe(0o640);
    expect(await readdir(join(dir, "guide"))).toEqual(["page.md"]);
    expect(log).toEqual(["guide/page.md", "Formatted 1 of 2 file(s)"]);
    expect(errors).toEqual([]);
  });

  test("formats one explicit file and labels it by name", async () => {
    await writeFile(join(dir, "page.md"), UNFORMATTED);

    await run(join(dir, "page.md"));

    expect(await readFile(join(dir, "page.md"), "utf8")).toBe(FORMATTED);
    expect(log).toEqual(["page.md", "Formatted 1 of 1 file(s)"]);
  });

  test("--check lists unformatted files, writes nothing and fails", async () => {
    await writeFile(join(dir, "a.md"), UNFORMATTED);
    await writeFile(join(dir, "b.md"), FORMATTED);

    await expect(run(dir, true)).rejects.toMatchObject({ id: "format-check-failed" });

    expect(await readFile(join(dir, "a.md"), "utf8")).toBe(UNFORMATTED);
    expect(log).toEqual(["a.md"]);
    expect(errors).toEqual(["1 of 2 file(s) need formatting"]);
  });

  test("--check passes when every file is formatted", async () => {
    await writeFile(join(dir, "a.md"), FORMATTED);

    await expect(run(dir, true)).resolves.toBeUndefined();

    expect(log).toEqual(["All 1 file(s) are formatted"]);
  });

  test("reports files that do not compile cleanly and leaves them untouched", async () => {
    const invalid = "# Raw\n\n<div>html</div>\n";
    await writeFile(join(dir, "bad.md"), invalid);
    await writeFile(join(dir, "good.md"), UNFORMATTED);

    await expect(run(dir)).rejects.toMatchObject({ id: "format-failed" });

    expect(await readFile(join(dir, "bad.md"), "utf8")).toBe(invalid);
    expect(await readFile(join(dir, "good.md"), "utf8")).toBe(FORMATTED);
    expect(errors).toEqual([
      "bad.md:3 critical node-undefined: This Markdown construct is not supported, such as raw HTML or footnotes.",
      "1 of 2 file(s) could not be formatted",
    ]);
  });

  test("refuses hard-linked and non-UTF-8 files without changing them", async () => {
    await writeFile(join(dir, "shared.md"), UNFORMATTED);
    await link(join(dir, "shared.md"), join(dir, "other-name.txt"));
    await writeFile(join(dir, "latin1.md"), Buffer.from([0x23, 0x20, 0xe9, 0x0a]));

    await expect(run(dir)).rejects.toMatchObject({ id: "format-failed" });

    expect(await readFile(join(dir, "shared.md"), "utf8")).toBe(UNFORMATTED);
    expect(errors).toEqual([
      "latin1.md: Markdown file could not be read or replaced safely.",
      "shared.md: Markdown file could not be read or replaced safely.",
      "2 of 2 file(s) could not be formatted",
    ]);
  });

  test("keeps machine paths out of its output", async () => {
    await writeFile(join(dir, "page.md"), "# x\n\n<div>html</div>\n");

    await expect(run(join(dir, "page.md"))).rejects.toBeDefined();

    expect([...log, ...errors].join("\n")).not.toContain(dir);
  });

  test.each([
    ["a non-Markdown file", "wiki.yaml", "format-target-unsupported"],
    ["a symbolic link", "link.md", "format-target-unsupported"],
    ["a missing path", "missing", "format-target-access-failed"],
  ])("rejects %s", async (_name, file, id) => {
    await writeFile(join(dir, "wiki.yaml"), "id: w\n");
    await writeFile(join(dir, "page.md"), UNFORMATTED);
    await symlink(join(dir, "page.md"), join(dir, "link.md"));

    await expect(run(join(dir, file))).rejects.toMatchObject({ id });
    expect(await readFile(join(dir, "page.md"), "utf8")).toBe(UNFORMATTED);
  });

  test("reports an empty directory", async () => {
    await run(dir);

    expect(log).toEqual(["No Markdown files found."]);
  });
});

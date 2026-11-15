import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { unifiedDiff } from "./diff";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("unifiedDiff", () => {
  test("returns nothing for identical files", () => {
    expect(unifiedDiff("a.md", "a.md", "x\n", "x\n")).toBe("");
  });

  test("prints git rename metadata for a pure rename", () => {
    expect(unifiedDiff("a.mdx", "a.md", "x\n", "x\n")).toBe(
      [
        "diff --git a/a.mdx b/a.md",
        "similarity index 100%",
        "rename from a.mdx",
        "rename to a.md",
        "",
      ].join("\n"),
    );
  });

  test("prints changed lines with three lines of context", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n") + "\n";
    const after = ["1", "2", "3", "4", "five", "6", "7", "8"].join("\n") + "\n";
    expect(unifiedDiff("p.md", "p.md", before, after)).toBe(
      [
        "diff --git a/p.md b/p.md",
        "--- a/p.md",
        "+++ b/p.md",
        "@@ -2,7 +2,7 @@",
        " 2",
        " 3",
        " 4",
        "-5",
        "+five",
        " 6",
        " 7",
        " 8",
        "",
      ].join("\n"),
    );
  });

  test("splits distant changes into separate hunks", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const changed = [...lines];
    changed[1] = "changed 2";
    changed[18] = "changed 19";
    const diff = unifiedDiff("p.md", "p.md", `${lines.join("\n")}\n`, `${changed.join("\n")}\n`);
    expect(diff.match(/^@@ .* @@$/gm)).toEqual(["@@ -1,5 +1,5 @@", "@@ -16,5 +16,5 @@"]);
  });

  test("describes a new file and a missing final newline", () => {
    expect(unifiedDiff(null, "wiki.yaml", "", "id: docs\ntitle: Docs")).toBe(
      [
        "diff --git a/wiki.yaml b/wiki.yaml",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/wiki.yaml",
        "@@ -0,0 +1,2 @@",
        "+id: docs",
        "+title: Docs",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  test("keeps insertions and deletions in order", () => {
    const diff = unifiedDiff("p.md", "p.md", "a\nb\nc\n", "a\nx\nc\ny\n");
    expect(diff.split("\n").slice(3)).toEqual([
      "@@ -1,3 +1,4 @@",
      " a",
      "-b",
      "+x",
      " c",
      "+y",
      "",
    ]);
  });

  test("keeps CR bytes in lines and splits only at LF", () => {
    expect(unifiedDiff("p.md", "p.md", "a\r\nb\r\n", "a\r\nB\r\n").split("\n").slice(3)).toEqual([
      "@@ -1,2 +1,2 @@",
      " a\r",
      "-b\r",
      "+B\r",
      "",
    ]);
    expect(unifiedDiff("p.md", "p.md", "a\rb\r", "a\rB\r").split("\n").slice(3)).toEqual([
      "@@ -1,1 +1,1 @@",
      "-a\rb\r",
      "\\ No newline at end of file",
      "+a\rB\r",
      "\\ No newline at end of file",
      "",
    ]);
  });

  test("quotes paths the way git does", () => {
    expect(unifiedDiff('q"t.mdx', 'q"t.md', "x\n", "x\n").split("\n")[0]).toBe(
      'diff --git "a/q\\"t.mdx" "b/q\\"t.md"',
    );
  });

  test.skipIf(!hasGit)("produces patches that git apply accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "topik-codemod-diff-"));
    try {
      const cases: Array<[string | null, string, string, string]> = [
        ["lf.md", "lf.md", "x\n<Note>y</Note>\nz\n", "x\nY\nz\n"],
        ["crlf.md", "crlf.md", "x\r\ny\r\nz\r\n", "x\r\nY\r\nz\r\n"],
        ["cr.md", "cr.md", "x\ry\rz\r", "x\rY\rz\r"],
        ["end.md", "end.md", "x\ny", "x\nY"],
        ["renamed.mdx", "renamed.md", "same\n", "same\n"],
        ["edited.mdx", "edited.md", "a\r\nb\r\n", "a\r\nB\r\n"],
        ["my page.mdx", "my page.md", "x\n", "y\n"],
        [null, "wiki.yaml", "", "id: docs\n"],
      ];
      let patch = "";
      for (const [oldName, newName, before, after] of cases) {
        if (oldName !== null) await writeFile(join(dir, oldName), before);
        patch += unifiedDiff(oldName, newName, before, after);
      }
      await writeFile(join(dir, "migration.patch"), patch);
      execFileSync("git", ["apply", "migration.patch"], { cwd: dir, stdio: "pipe" });
      for (const [, newName, , after] of cases)
        expect(await readFile(join(dir, newName), "utf8")).toBe(after);
      expect((await readdir(dir)).sort()).toEqual(
        [...cases.map(([, newName]) => newName), "migration.patch"].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

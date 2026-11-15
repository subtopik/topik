import { describe, expect, test } from "vite-plus/test";
import { unifiedDiff } from "./diff";

describe("unifiedDiff", () => {
  test("returns nothing for identical files", () => {
    expect(unifiedDiff("a.md", "a.md", "x\n", "x\n")).toBe("");
  });

  test("prints only headers for a pure rename", () => {
    expect(unifiedDiff("a.mdx", "a.md", "x\n", "x\n")).toBe("--- a/a.mdx\n+++ b/a.md\n");
  });

  test("prints changed lines with three lines of context", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n") + "\n";
    const after = ["1", "2", "3", "4", "five", "6", "7", "8"].join("\n") + "\n";
    expect(unifiedDiff("p.md", "p.md", before, after)).toBe(
      [
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
    expect(diff.split("\n").slice(2)).toEqual([
      "@@ -1,3 +1,4 @@",
      " a",
      "-b",
      "+x",
      " c",
      "+y",
      "",
    ]);
  });
});

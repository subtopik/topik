import { validateTopikContent } from "@topik/content-schema";
import { describe, expect, test } from "vite-plus/test";
import { formatDiagnostic } from "./diagnostics";

describe("CLI diagnostic serialization", () => {
  test("does not print malformed external reference text", () => {
    const sentinel = "PRIVATE_VALUE";
    const result = validateTopikContent(
      `{% card title="Unsafe" href="https://user:${sentinel}@[" /%}`,
    );
    const output = result.errors.map(formatDiagnostic).join("\n");

    expect(output).not.toBe("");
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain("https://user:");
  });

  test("re-applies stable link wording before CLI presentation", () => {
    const sentinel = "PRIVATE_VALUE";
    const output = formatDiagnostic({
      id: "link-page-not-found",
      type: "link",
      level: "error",
      message: `Missing /private-value?token=${sentinel}#${sentinel}`,
      lines: [2],
      file: "intro.md",
    });

    expect(output).toBe(
      "intro.md:2 error link-page-not-found: Internal link target page was not found.",
    );
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain("private-value");
  });

  test.each(["/var/redacted/docs/page.md", String.raw`C:\redacted\docs\page.md`])(
    "sanitizes absolute path %s",
    (file) => {
      const output = formatDiagnostic({
        id: "test-diagnostic",
        type: "content",
        level: "error",
        message: "Invalid content",
        lines: [3],
        file,
      });

      expect(output).toBe("page.md:3 error test-diagnostic: Invalid content");
      expect(output).not.toMatch(/var|redacted|C:/u);
    },
  );
});

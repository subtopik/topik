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

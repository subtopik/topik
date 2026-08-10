import { describe, expect, test } from "vite-plus/test";
import { formatDiagnostic } from "./diagnostics";

describe("CLI diagnostic serialization", () => {
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

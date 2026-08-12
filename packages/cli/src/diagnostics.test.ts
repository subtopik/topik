import { validateTopikContent } from "@topik/content-schema";
import { describe, expect, test } from "vite-plus/test";
import { formatDiagnostic } from "./diagnostics";

const unsafeDiagnosticFiles = [
  "/tmp/SENSITIVE_DIRECTORY/lesson.md",
  String.raw`C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\server\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Device\HarddiskVolume1\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL`,
  String.raw`\\user:FILE_CREDENTIAL_SENTINEL@server\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL`,
  "https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  "//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
] as const;

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

  test.each(unsafeDiagnosticFiles)("sanitizes absolute path %s", (file) => {
    const output = formatDiagnostic({
      id: "test-diagnostic",
      type: "content",
      level: "error",
      message: "Invalid content",
      lines: [3],
      file,
    });

    expect(output).toBe("lesson.md:3 error test-diagnostic: Content validation failed.");
    expect(output).not.toMatch(
      /SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u,
    );
  });

  test.each(["lesson.md", "guides/lesson.md", String.raw`guides\lesson.md`])(
    "preserves safe relative label %s",
    (file) => {
      expect(
        formatDiagnostic({
          id: "test-diagnostic",
          type: "content",
          level: "error",
          message: "Invalid content",
          lines: [],
          file,
        }),
      ).toBe(`${file} error test-diagnostic: Content validation failed.`);
    },
  );
});

import { describe, expect, test } from "vite-plus/test";
import type { TopikContentDiagnostic } from "@topik/content-schema";
import {
  CompileError,
  extractMarkdownTitle,
  hasCompileErrors,
  isErrorDiagnostic,
  parseMarkdownFrontmatter,
  parseReferenceList,
} from "./shared";

const diagnostic = (level: TopikContentDiagnostic["level"]): TopikContentDiagnostic => ({
  id: "test",
  type: "document",
  level,
  message: "Test diagnostic",
  lines: [],
});

const unsafeDiagnosticFiles = [
  "/tmp/SENSITIVE_DIRECTORY/lesson.md",
  String.raw`C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\server\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Device\HarddiskVolume1\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\\user:FILE_CREDENTIAL_SENTINEL@server\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  "https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  "//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
] as const;

const ambiguousDiagnosticFiles = [
  " https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https%3A%2F%2Fuser%3AFILE_CREDENTIAL_SENTINEL%40example.com%2FSENSITIVE_DIRECTORY%2Flesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL",
  "https%253A%252F%252Fuser%253AFILE_CREDENTIAL_SENTINEL%2540example.com%252FSENSITIVE_DIRECTORY%252Flesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL",
  "/tmp/SENSITIVE_DIRECTORY%2Flesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL",
  String.raw`C:\SENSITIVE_DIRECTORY%5Clesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL`,
  String.raw`\\server\SENSITIVE_DIRECTORY%5Clesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL`,
  "https://example.com/SENSITIVE_DIRECTORY%2Flesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  "https://user:%46ILE_CREDENTIAL_SENTINEL@example.com/lesson.md",
  "https://user:%46ILE_CREDENTIAL_SENTINEL@[?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL",
  "https ://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&amp;colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&#58;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "\u0085/tmp/SENSITIVE_DIRECTORY/lesson.md",
  "\u200B/tmp/SENSITIVE_DIRECTORY/lesson.md",
  "\u202E/tmp/SENSITIVE_DIRECTORY/lesson.md",
] as const;

describe("compile error diagnostics", () => {
  test.each(["error", "critical"] as const)("treats %s as an error", (level) => {
    expect(isErrorDiagnostic(diagnostic(level))).toBe(true);
    expect(hasCompileErrors([diagnostic(level)])).toBe(true);
  });

  test.each(["warning", "info", "debug"] as const)("does not treat %s as an error", (level) => {
    expect(isErrorDiagnostic(diagnostic(level))).toBe(false);
    expect(hasCompileErrors([diagnostic(level)])).toBe(false);
  });

  test.each(unsafeDiagnosticFiles)(
    "sanitizes diagnostic path %s in public CompileError state and text",
    (file) => {
      const error = new CompileError([{ ...diagnostic("error"), file }]);

      expect(error.diagnostics).toEqual([expect.objectContaining({ file: "lesson.md" })]);
      expect(`${error.message}\n${JSON.stringify(error)}`).not.toMatch(
        /SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u,
      );
    },
  );

  test.each(ambiguousDiagnosticFiles)("fails an ambiguous CompileError label closed", (file) => {
    const error = new CompileError([{ ...diagnostic("error"), file }]);

    expect(error.diagnostics).toEqual([expect.objectContaining({ file: "content" })]);
    expect(`${error.message}\n${JSON.stringify(error)}`).not.toMatch(
      /SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL|%2F|%25/iu,
    );
  });
});

describe("parseMarkdownFrontmatter", () => {
  test("parses frontmatter objects and returns the remaining content", () => {
    expect(parseMarkdownFrontmatter("---\ntitle: Hello\n---\n\n# Heading", "guide.md")).toEqual({
      frontmatter: { title: "Hello" },
      content: "\n# Heading",
    });
  });

  test("rejects non-object frontmatter", () => {
    expect(() => parseMarkdownFrontmatter("---\n- invalid\n---\nbody", "guide.md")).toThrow(
      "Document frontmatter is invalid.",
    );
  });
});

describe("extractMarkdownTitle", () => {
  test("prefers the first markdown heading", () => {
    expect(extractMarkdownTitle("# Hello World\n\nBody", "fallback-title")).toBe("Hello World");
  });

  test("formats the fallback slug when no heading exists", () => {
    expect(extractMarkdownTitle("No heading", "getting-started")).toBe("Getting Started");
  });
});

describe("parseReferenceList", () => {
  test("returns undefined for absent values", () => {
    expect(parseReferenceList(undefined, "authors", "guide.md")).toBeUndefined();
  });

  test("accepts valid DNS-style references", () => {
    expect(parseReferenceList(["john-doe", "jane-smith"], "authors", "guide.md")).toEqual([
      "john-doe",
      "jane-smith",
    ]);
  });

  test("rejects invalid references", () => {
    expect(() => parseReferenceList(["John Doe"], "authors", "guide.md")).toThrow(
      "Document resource references are invalid.",
    );
  });
});

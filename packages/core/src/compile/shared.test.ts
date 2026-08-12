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
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL`,
  String.raw`\\user:FILE_CREDENTIAL_SENTINEL@server\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
  String.raw`\\?\C:\SENSITIVE_DIRECTORY\lesson.md?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL`,
  "https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  "//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
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

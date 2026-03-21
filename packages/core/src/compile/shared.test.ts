import { describe, expect, test } from "vite-plus/test";
import { extractMarkdownTitle, parseMarkdownFrontmatter, parseReferenceList } from "./shared";

describe("parseMarkdownFrontmatter", () => {
  test("parses frontmatter objects and returns the remaining content", () => {
    expect(parseMarkdownFrontmatter("---\ntitle: Hello\n---\n\n# Heading", "guide.md")).toEqual({
      frontmatter: { title: "Hello" },
      content: "\n# Heading",
    });
  });

  test("rejects non-object frontmatter", () => {
    expect(() => parseMarkdownFrontmatter("---\n- invalid\n---\nbody", "guide.md")).toThrow(
      "Invalid frontmatter in guide.md: Frontmatter must parse to an object",
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
      "authors[0] in guide.md must be a DNS-1123 resource name",
    );
  });
});

import { describe, expect, test } from "vite-plus/test";
import { parse as parseYaml } from "yaml";
import {
  collectionGuideFilter,
  isConventionMarkdownFilename,
  parseCollectionConfig,
} from "./collection";

const parse = (yaml: string) => parseCollectionConfig(parseYaml(yaml));

describe("parseCollectionConfig", () => {
  test("parses a minimal collection", () => {
    const config = parse(`
id: guides
title: Guides
`);
    expect(config.id).toBe("guides");
    expect(config.title).toBe("Guides");
    expect(config.tags).toBeUndefined();
  });

  test("parses collection with tags", () => {
    const config = parse(`
id: blog
title: Blog Posts
tags:
  - react
  - typescript
`);
    expect(config.tags).toEqual(["react", "typescript"]);
  });

  test("rejects invalid id format", () => {
    expect(() =>
      parse(`
id: Invalid Name!
title: Bad
`),
    ).toThrow();
  });

  test("rejects missing id", () => {
    expect(() => parse("title: Missing ID")).toThrow();
  });

  test("rejects missing title", () => {
    expect(() => parse("id: no-title")).toThrow();
  });
});

describe("include and exclude", () => {
  test("accepts relative patterns with *, ? and **", () => {
    const config = parse(`
id: blog
title: Blog
include: ["**/*.md", "guides/part-?/*.mdx"]
exclude: ["drafts/**"]
`);
    expect(config.include).toEqual(["**/*.md", "guides/part-?/*.mdx"]);
    expect(config.exclude).toEqual(["drafts/**"]);
  });

  test.each([
    "/abs/*.md",
    "../outside/*.md",
    "./here.md",
    "a//b.md",
    "a\\b.md",
    "a/**b/c.md",
    "{a,b}.md",
    "[ab].md",
    "!skip.md",
    "C:/guides/*.md",
    "c:guides/*.md",
    "",
  ])("rejects the pattern %j", (pattern) => {
    expect(() =>
      parseCollectionConfig({ id: "blog", title: "Blog", include: [pattern] }),
    ).toThrow();
    expect(() =>
      parseCollectionConfig({ id: "blog", title: "Blog", exclude: [pattern] }),
    ).toThrow();
  });

  test("rejects an empty include list and a misspelled key", () => {
    expect(() => parseCollectionConfig({ id: "blog", title: "Blog", include: [] })).toThrow();
    expect(() => parseCollectionConfig({ id: "blog", title: "Blog", excludes: [] })).toThrow();
  });

  test("by default matches only Markdown beside the configuration", () => {
    const filter = collectionGuideFilter({});
    expect(filter.nested).toBe(false);
    expect(
      ["a.md", "a.mdx", "a.txt", "sub/a.md", "README.md", "AGENTS.md"].filter((path) =>
        filter.matches(path),
      ),
    ).toEqual(["a.md", "a.mdx", "README.md"]);
  });

  test("matches folders, and never dependencies, dot-directories or convention files", () => {
    const filter = collectionGuideFilter({
      include: ["**/*.md", "extra/**"],
      exclude: ["drafts/**", "**/skip-?.md"],
    });
    expect(filter.nested).toBe(true);
    expect(
      [
        "a.md",
        "sub/deep/a.md",
        "sub/a.mdx",
        "extra/a.mdx",
        "extra/data.json",
        "drafts/a.md",
        "sub/skip-1.md",
        "sub/skip-10.md",
        "node_modules/pkg/a.md",
        "sub/.cache/a.md",
        "sub/CHANGELOG.md",
        "sub/README.md",
        "a.md.bak",
      ].filter((path) => filter.matches(path)),
    ).toEqual(["a.md", "sub/deep/a.md", "extra/a.mdx", "sub/skip-10.md", "sub/README.md"]);
  });

  test("treats pattern characters other than the wildcards literally", () => {
    const filter = collectionGuideFilter({ include: ["v1.0+beta/*.md"] });
    expect(filter.matches("v1.0+beta/a.md")).toBe(true);
    expect(filter.matches("v1x0+beta/a.md")).toBe(false);
    // The schema refuses these characters; the matcher still never reads them as syntax.
    const unchecked = collectionGuideFilter({ include: ["a\\d(b)[c]{1}|^$/*.md"] });
    expect(unchecked.matches("a\\d(b)[c]{1}|^$/x.md")).toBe(true);
    expect(unchecked.matches("a1bc/x.md")).toBe(false);
  });

  test("wildcards match as documented at the edges", () => {
    const matches = (pattern: string, path: string) =>
      collectionGuideFilter({ include: [pattern] }).matches(path);
    expect(matches("**/**/a.md", "a.md")).toBe(true);
    expect(matches("**/**/a.md", "x/y/a.md")).toBe(true);
    expect(matches("x/**", "x.md")).toBe(false);
    expect(matches("x/**", "x/a.md")).toBe(true);
    expect(matches("x/**/y/*.md", "x/y/a.md")).toBe(true);
    expect(matches("x/**/y/*.md", "x/1/2/y/a.md")).toBe(true);
    expect(matches("x/**/y/*.md", "x/1/a.md")).toBe(false);
    expect(matches("*a*b*.md", "xaxbx.md")).toBe(true);
    expect(matches("*a*b*.md", "xbxax.md")).toBe(false);
    expect(matches("?.md", "ab.md")).toBe(false);
    expect(matches("?.md", "é.md")).toBe(true);
    expect(matches("*", "sub/a.md")).toBe(false);
  });

  test("matching time stays bounded for patterns built to backtrack", () => {
    const started = performance.now();
    const deep = collectionGuideFilter({
      include: [`${"**/a/".repeat(40)}*.md`, `${"*a".repeat(100)}*b.md`],
    });
    expect(deep.matches(`${"a/".repeat(120)}x.mdx`)).toBe(false);
    expect(deep.matches(`${"a".repeat(240)}.md`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a convention filename has an uppercase letter and no lowercase one", () => {
    expect(
      ["README.md", "CODE_OF_CONDUCT.md", "AGENTS.mdx", "A1.md"].every(
        isConventionMarkdownFilename,
      ),
    ).toBe(true);
    expect(
      ["readme.md", "Readme.md", "2024.md", "a-b.md", "v1.0.md"].some(isConventionMarkdownFilename),
    ).toBe(false);
  });
});

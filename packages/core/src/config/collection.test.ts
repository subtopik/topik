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

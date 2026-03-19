import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseTopikConfig } from "./topik";

const parse = (yaml: string) => parseTopikConfig(parseYaml(yaml));

describe("parseTopikConfig", () => {
  test("parses a minimal collection", () => {
    const config = parse(`
collections:
  - name: guides
    path: content/guides
`);
    expect(config.collections).toHaveLength(1);
    expect(config.collections[0].name).toBe("guides");
    expect(config.collections[0].path).toBe("content/guides");
    expect(config.collections[0].format).toBe("topik");
    expect(config.collections[0].tags).toBeUndefined();
  });

  test("parses collection with tags", () => {
    const config = parse(`
collections:
  - name: blog
    path: content/blog
    tags:
      - react
      - typescript
`);
    const col = config.collections[0];
    expect(col.tags).toEqual(["react", "typescript"]);
  });

  test("parses multiple collections", () => {
    const config = parse(`
collections:
  - name: guides
    path: content/guides
  - name: blog
    path: content/blog
`);
    expect(config.collections).toHaveLength(2);
    expect(config.collections[0].name).toBe("guides");
    expect(config.collections[1].name).toBe("blog");
  });

  test("defaults format to topik", () => {
    const config = parse(`
collections:
  - name: posts
`);
    expect(config.collections[0].format).toBe("topik");
    expect(config.collections[0].path).toBe(".");
  });

  test("rejects empty collections array", () => {
    expect(() => parse("collections: []")).toThrow();
  });

  test("rejects invalid name format", () => {
    expect(() =>
      parse(`
collections:
  - name: Invalid Name!
    path: content
`),
    ).toThrow();
  });

  test("rejects missing name", () => {
    expect(() =>
      parse(`
collections:
  - path: content/guides
`),
    ).toThrow();
  });

  test("rejects invalid format", () => {
    expect(() =>
      parse(`
collections:
  - name: guides
    format: html
`),
    ).toThrow();
  });
});

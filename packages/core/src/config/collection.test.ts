import { describe, expect, test } from "vite-plus/test";
import { parse as parseYaml } from "yaml";
import { parseCollectionConfig } from "./collection";

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

import { describe, expect, test } from "vitest";
import { parseWikiConfig } from "./wiki";

describe("parseWikiConfig", () => {
  test("parses minimal config", () => {
    const config = parseWikiConfig({ id: "docs", title: "Docs" });
    expect(config.id).toBe("docs");
    expect(config.title).toBe("Docs");
    expect(config.navigation).toBeUndefined();
  });

  test("parses config with string page references", () => {
    const config = parseWikiConfig({
      id: "docs",
      title: "Documentation",
      navigation: ["getting-started", "installation"],
    });
    expect(config.navigation).toEqual(["getting-started", "installation"]);
  });

  test("parses config with groups and links", () => {
    const config = parseWikiConfig({
      id: "docs",
      title: "Documentation",
      navigation: [
        {
          group: "Advanced",
          children: ["custom-themes"],
        },
        { href: "https://github.com", title: "GitHub" },
      ],
    });
    expect(config.navigation).toHaveLength(2);
  });

  test("parses nested groups", () => {
    const config = parseWikiConfig({
      id: "docs",
      title: "Documentation",
      navigation: [
        {
          group: "Runtime",
          children: [
            {
              group: "HTTP",
              children: ["runtime/http/server"],
            },
          ],
        },
      ],
    });
    const nav = config.navigation!;
    const runtime = nav[0] as { group: string; children: unknown[] };
    expect(runtime.group).toBe("Runtime");
    const http = runtime.children[0] as { group: string; children: string[] };
    expect(http.group).toBe("HTTP");
    expect(http.children).toEqual(["runtime/http/server"]);
  });

  test("rejects javascript: URIs in link href", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [{ href: "javascript:alert(1)", title: "XSS" }],
      }),
    ).toThrow();
  });

  test("rejects missing id", () => {
    expect(() => parseWikiConfig({ title: "Docs" })).toThrow();
  });

  test("rejects invalid id format", () => {
    expect(() => parseWikiConfig({ id: "Not Valid", title: "Docs" })).toThrow();
  });

  test("rejects missing title", () => {
    expect(() => parseWikiConfig({ id: "docs" })).toThrow();
  });

  test("rejects empty title", () => {
    expect(() => parseWikiConfig({ id: "docs", title: "" })).toThrow();
  });

  test("defaults group children to empty array", () => {
    const config = parseWikiConfig({
      id: "docs",
      title: "Docs",
      navigation: [{ group: "Empty" }],
    });
    const group = config.navigation![0] as { group: string; children: unknown[] };
    expect(group.children).toEqual([]);
  });

  test("supports optional slug and icon on groups", () => {
    const config = parseWikiConfig({
      id: "docs",
      title: "Docs",
      navigation: [{ group: "Getting Started", slug: "start", icon: "rocket" }],
    });
    const group = config.navigation![0] as { slug: string; icon: string };
    expect(group.slug).toBe("start");
    expect(group.icon).toBe("rocket");
  });
});

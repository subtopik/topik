import { describe, expect, test } from "vite-plus/test";
import { parseWikiConfig } from "./wiki";

describe("parseWikiConfig", () => {
  test("parses minimal config", () => {
    const config = parseWikiConfig({ id: "docs", title: "Docs" });
    expect(config).toMatchObject({ id: "docs", title: "Docs" });
    expect(config.navigation).toBeUndefined();
  });

  test("parses optional and null descriptions", () => {
    expect(
      parseWikiConfig({ id: "docs", title: "Docs", description: "Documentation" }).description,
    ).toBe("Documentation");
    expect(
      parseWikiConfig({ id: "docs", title: "Docs", description: null }).description,
    ).toBeNull();
  });

  test("parses string and explicit page nodes", () => {
    const config = parseWikiConfig({
      id: "docs",
      title: "Documentation",
      navigation: ["getting-started", { type: "page", slug: "installation" }],
    });
    expect(config.navigation).toEqual(["getting-started", { type: "page", slug: "installation" }]);
  });

  test("parses the canonical tab, dropdown, group, page hierarchy", () => {
    const config = parseWikiConfig({
      id: "docs",
      title: "Documentation",
      navigation: [
        {
          type: "tab",
          title: "Documentation",
          slug: "docs",
          children: [
            {
              type: "dropdown",
              title: "Guides",
              slug: "guides",
              children: [
                {
                  type: "group",
                  title: "Runtime",
                  slug: "runtime",
                  children: ["overview"],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(config.navigation).toHaveLength(1);
    expect(config.navigation).toEqual([
      {
        type: "tab",
        title: "Documentation",
        slug: "docs",
        children: [
          {
            type: "dropdown",
            title: "Guides",
            slug: "guides",
            children: [
              {
                type: "group",
                title: "Runtime",
                slug: "runtime",
                children: ["overview"],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("parses external switcher entries and sidebar links", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [
          { type: "tab", title: "Docs", slug: "docs", children: [] },
          { type: "tab", title: "Blog", href: "https://example.com" },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [{ type: "link", title: "GitHub", href: "https://github.com" }],
      }),
    ).not.toThrow();
  });

  test("rejects mixed navigation surfaces at one level", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [
          { type: "tab", title: "Docs", slug: "docs", children: [] },
          { type: "group", title: "Guides", slug: "guides", children: [] },
        ],
      }),
    ).toThrow(
      "Navigation surfaces cannot be mixed at the same level: expected tab, found sidebar at navigation[1]",
    );
  });

  test("rejects tabs below the root", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [
          {
            type: "group",
            title: "Guides",
            slug: "guides",
            children: [{ type: "tab", title: "Nested", slug: "nested", children: [] }],
          },
        ],
      }),
    ).toThrow("Navigation tab nodes are not allowed at navigation[0].children[0]");
  });

  test("rejects tabs inside dropdowns", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [
          {
            type: "dropdown",
            title: "Docs",
            slug: "docs",
            children: [{ type: "tab", title: "Nested", slug: "nested", children: [] }],
          },
        ],
      }),
    ).toThrow("Navigation tab nodes are not allowed at navigation[0].children[0]");
  });

  test("accepts pathless tabs, dropdowns, and groups", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [
          {
            type: "tab",
            title: "Documentation",
            children: [
              {
                type: "dropdown",
                title: "Guides",
                children: [{ type: "group", title: "Getting Started", children: ["overview"] }],
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  test.each(["tab", "dropdown", "group"] as const)("rejects an empty slug on %s nodes", (type) => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [{ type, title: "Empty", slug: "", children: [] }],
      }),
    ).toThrow();
  });

  test("rejects duplicate full routes, including index aliases", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [
          { type: "page", slug: "guides" },
          {
            type: "group",
            title: "Guides",
            slug: "guides",
            children: ["index"],
          },
        ],
      }),
    ).toThrow(
      "Navigation contains duplicate page route /guides: first defined at navigation[0], duplicated at navigation[1].children[0]",
    );
  });

  test("detects collisions through pathless switchers", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [
          { type: "tab", title: "Guides", children: ["overview"] },
          { type: "tab", title: "API", children: ["overview"] },
        ],
      }),
    ).toThrow("Navigation contains duplicate page route /overview");
  });

  test("rejects unsafe external links", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [{ type: "link", title: "XSS", href: "javascript:alert(1)" }],
      }),
    ).toThrow();
  });

  test.each(["https://", "http://", "https://[invalid"])(
    "rejects malformed external URL %s",
    (href) => {
      expect(() =>
        parseWikiConfig({
          id: "docs",
          title: "Docs",
          navigation: [{ type: "link", title: "Malformed", href }],
        }),
      ).toThrow("href must be a valid http or https URL");
    },
  );

  test.each([
    ["page", [{ type: "page", slug: "intro", icon: "foo/bar" }]],
    ["group", [{ type: "group", title: "Guides", icon: "foo/bar", children: [] }]],
    ["tab", [{ type: "tab", title: "Docs", icon: "foo/bar", children: [] }]],
    ["dropdown", [{ type: "dropdown", title: "Docs", icon: "foo/bar", children: [] }]],
    ["link", [{ type: "link", title: "GitHub", icon: "foo/bar", href: "https://github.com" }]],
  ])("rejects schema-invalid icons on %s nodes", (_type, navigation) => {
    expect(() => parseWikiConfig({ id: "docs", title: "Docs", navigation })).toThrow(
      "Icons must be lowercase DNS-style names",
    );
  });

  test("rejects switchers that define both an internal slug and external href", () => {
    expect(() =>
      parseWikiConfig({
        id: "docs",
        title: "Docs",
        navigation: [
          {
            type: "tab",
            title: "Ambiguous",
            slug: "ambiguous",
            href: "https://example.com",
          },
        ],
      }),
    ).toThrow();
  });

  test("validates wiki identity and description limits", () => {
    expect(() => parseWikiConfig({ title: "Docs" })).toThrow();
    expect(() => parseWikiConfig({ id: "Not Valid", title: "Docs" })).toThrow();
    expect(() => parseWikiConfig({ id: "a".repeat(47), title: "Docs" })).toThrow(
      "Wiki id must be 46 characters or fewer",
    );
    expect(() =>
      parseWikiConfig({ id: "docs", title: "Docs", description: "a".repeat(1025) }),
    ).toThrow();
  });
});

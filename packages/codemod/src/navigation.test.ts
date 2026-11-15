import { describe, expect, test } from "vite-plus/test";
import { convertMintlifyNavigation } from "./navigation";

const pages = new Set(["index", "quickstart", "guides/setup", "guides/deploy", "api/users"]);

describe("convertMintlifyNavigation", () => {
  test("converts docs.json groups and nested groups to a sidebar", () => {
    const result = convertMintlifyNavigation(
      "docs.json",
      {
        $schema: "https://mintlify.com/docs.json",
        name: "Acme Docs",
        description: "Acme: product docs",
        navigation: {
          groups: [
            { group: "Get started", pages: ["index", "quickstart"] },
            {
              group: "Guides",
              expanded: true,
              pages: [
                "guides/setup",
                { group: "Shipping", hidden: false, pages: ["guides/deploy"] },
              ],
            },
          ],
        },
      },
      pages,
    );
    expect(result.warnings).toEqual([]);
    expect(result.yaml).toBe(
      [
        "id: acme-docs",
        "title: Acme Docs",
        'description: "Acme: product docs"',
        "navigation:",
        "  - type: group",
        "    title: Get started",
        "    children:",
        "      - index",
        "      - quickstart",
        "  - type: group",
        "    title: Guides",
        "    expanded: true",
        "    children:",
        "      - guides/setup",
        "      - type: group",
        "        title: Shipping",
        "        hidden: false",
        "        children:",
        "          - guides/deploy",
        "",
      ].join("\n"),
    );
  });

  test("converts tabs, dropdowns and external tabs", () => {
    const result = convertMintlifyNavigation(
      "docs.json",
      {
        name: "Acme",
        navigation: {
          tabs: [
            { tab: "Guides", pages: ["index", "quickstart"] },
            {
              tab: "Reference",
              dropdowns: [{ dropdown: "REST", groups: [{ group: "Users", pages: ["api/users"] }] }],
            },
            { tab: "Blog", href: "https://example.com/blog" },
          ],
        },
      },
      pages,
    );
    expect(result.warnings).toEqual([]);
    expect(result.yaml).toBe(
      [
        "id: acme",
        "title: Acme",
        "navigation:",
        "  - type: tab",
        "    title: Guides",
        "    children:",
        "      - index",
        "      - quickstart",
        "  - type: tab",
        "    title: Reference",
        "    children:",
        "      - type: dropdown",
        "        title: REST",
        "        children:",
        "          - type: group",
        "            title: Users",
        "            children:",
        "              - api/users",
        "  - type: tab",
        "    title: Blog",
        '    href: "https://example.com/blog"',
        "",
      ].join("\n"),
    );
  });

  test("converts legacy mint.json groups and reports legacy tabs and anchors", () => {
    const result = convertMintlifyNavigation(
      "mint.json",
      {
        name: "Legacy",
        navigation: [{ group: "Start", icon: "rocket", pages: ["index"] }],
        tabs: [{ name: "API", url: "api" }],
        anchors: [{ name: "Blog", url: "https://example.com" }],
      },
      pages,
    );
    expect(result.yaml).toContain(
      "  - type: group\n    title: Start\n    children:\n      - index\n",
    );
    expect(result.warnings).toEqual([
      "navigation[0].icon: icons are dropped",
      "tabs: has no Topik equivalent; not converted, and their groups stay in the sidebar",
      "anchors: has no Topik equivalent; not converted, and their groups stay in the sidebar",
    ]);
  });

  test("reports entries without a direct Topik equivalent instead of guessing", () => {
    const result = convertMintlifyNavigation(
      "docs.json",
      {
        name: "Acme",
        navigation: {
          groups: [
            {
              group: "Start",
              tag: "NEW",
              pages: ["index", "Missing_Case", "missing", "/quickstart", "index", 3],
            },
          ],
          anchors: [{ anchor: "Blog", href: "https://example.com" }],
          versions: [{ version: "v1", pages: ["guides/setup"] }],
          tabs: [{ tab: "Mixed", pages: ["guides/deploy"] }],
          global: { anchors: [] },
        },
      },
      pages,
    );
    expect(result.yaml).toContain("      - index\n      - quickstart\n");
    expect(result.yaml).not.toContain("guides/");
    expect(result.warnings).toEqual([
      "navigation.groups[0].tag: has no Topik equivalent; not converted",
      'navigation.groups[0].pages[1]: page "Missing_Case" is not a lowercase Topik page path (letters, digits and hyphens separated by /); not converted',
      'navigation.groups[0].pages[2]: page "missing" has no .md or .mdx file in the directory; not converted',
      'navigation.groups[0].pages[4]: page "index" repeats the route of navigation.groups[0].pages[0]; not converted',
      "navigation.groups[0].pages[5]: is not a page reference or a group; not converted",
      "navigation.anchors: has no Topik equivalent; not converted",
      "navigation.versions: has no Topik equivalent; not converted",
      "navigation.tabs: tabs cannot be mixed with groups and pages at one level; not converted",
      "navigation.global: has no Topik equivalent; not converted",
    ]);
  });

  test("writes no configuration without a usable site name", () => {
    expect(convertMintlifyNavigation("docs.json", { navigation: {} }, pages)).toEqual({
      warnings: ["name: a site name of 1 to 256 characters is required; no wiki.yaml written"],
    });
    expect(convertMintlifyNavigation("docs.json", { name: "文档" }, pages).yaml).toBeUndefined();
    expect(convertMintlifyNavigation("docs.json", [], pages).yaml).toBeUndefined();
  });

  test("quotes YAML scalars that would not read back as the same string", () => {
    const result = convertMintlifyNavigation(
      "docs.json",
      { name: "Yes", navigation: { groups: [{ group: "A: b #c", pages: [] }] } },
      pages,
    );
    expect(result.yaml).toBe(
      'id: "yes"\ntitle: "Yes"\nnavigation:\n  - type: group\n    title: "A: b #c"\n    children: []\n',
    );
  });
});

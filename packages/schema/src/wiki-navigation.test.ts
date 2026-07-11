import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, test } from "vite-plus/test";
import type { Wiki, WikiNavigation } from "./wiki";
import {
  findFirstWikiPage,
  findWikiPageAncestors,
  hasWikiNavChildren,
  isExternalWikiDropdown,
  isExternalWikiTab,
  isInternalWikiDropdown,
  isInternalWikiTab,
  resolveWikiContentHref,
  resolveWikiNavigation,
} from "./wiki-navigation";

const fixturePath = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "wiki",
  "valid",
  "navigation-conformance.yaml",
);
const wiki = parseYaml(readFileSync(fixturePath, "utf8")) as Wiki;
const navigation = wiki.spec.navigation!;

const typeParityFixture = [
  {
    type: "tab",
    title: "Docs",
    children: [
      { type: "dropdown", title: "Guides", children: [{ type: "page", page: "intro", slug: "" }] },
      { type: "dropdown", title: "Blog", href: "https://example.com" },
    ],
  },
  { type: "tab", title: "GitHub", href: "https://github.com/subtopik/topik" },
] satisfies WikiNavigation;

describe("wiki navigation type guards", () => {
  test("keeps representative public TypeScript types aligned", () => {
    expect(resolveWikiNavigation(typeParityFixture).pages[0]?.page).toBe("intro");
  });

  test("distinguishes internal and external switchers", () => {
    const docs = navigation[0];
    const github = navigation[1];
    expect(isInternalWikiTab(docs)).toBe(true);
    expect(isExternalWikiTab(github)).toBe(true);
    expect(hasWikiNavChildren(docs)).toBe(true);

    if (!isInternalWikiTab(docs)) throw new Error("Expected internal tab");
    expect(isInternalWikiDropdown(docs.children[0])).toBe(true);
    expect(isExternalWikiDropdown(docs.children[1])).toBe(true);
  });
});

describe("resolveWikiNavigation", () => {
  const resolved = resolveWikiNavigation(navigation);

  test("resolves routes, index source paths, and page order", () => {
    expect(resolved.pages.map((page) => page.page)).toEqual([
      "guides-index",
      "guides-installation",
    ]);
    expect(resolved.pageByName.get("guides-index")).toMatchObject({
      route: "docs/guides",
      sourcePath: "docs/guides/index",
    });
    expect(resolved.pageByRoute.get("docs/guides/installation")?.page).toBe("guides-installation");
  });

  test("retains owning navigation containers", () => {
    expect(findWikiPageAncestors(resolved, "guides-installation").map((node) => node.type)).toEqual(
      ["tab", "dropdown", "group"],
    );
    expect(findFirstWikiPage(navigation)?.page).toBe("guides-index");
  });

  test("resolves relative, absolute, extension, index, and heading links", () => {
    expect(
      resolveWikiContentHref("./installation.md#setup", "guides-index", resolved),
    ).toMatchObject({ route: "docs/guides/installation", hash: "setup" });
    expect(
      resolveWikiContentHref("/docs/guides/index.mdx", "guides-installation", resolved),
    ).toMatchObject({ route: "docs/guides", hash: "" });
    expect(resolveWikiContentHref("#intro", "guides-index", resolved)).toMatchObject({
      route: "docs/guides",
      hash: "intro",
    });
    expect(resolveWikiContentHref("https://example.com", "guides-index", resolved)).toBeNull();
  });

  test("rejects duplicate canonical pages and routes", () => {
    expect(() =>
      resolveWikiNavigation([
        { type: "page", page: "same-page", slug: "one" },
        { type: "page", page: "same-page", slug: "two" },
      ]),
    ).toThrow("contains page same-page more than once");
    expect(() =>
      resolveWikiNavigation([
        { type: "page", page: "one", slug: "guide" },
        {
          type: "group",
          title: "Guide",
          slug: "guide",
          children: [{ type: "page", page: "two", slug: "" }],
        },
      ]),
    ).toThrow("contains duplicate route /guide");
  });
});

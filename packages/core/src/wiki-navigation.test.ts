import { describe, expect, test } from "vite-plus/test";
import type { WikiNavigation } from "@topik/schema/wiki/v1";
import {
  findFirstWikiPage,
  findWikiPageAncestors,
  hasWikiNavChildren,
  isExternalWikiDropdown,
  isExternalWikiTab,
  isInternalWikiDropdown,
  isInternalWikiTab,
  resolveWikiContentHref,
  resolveWikiContentReference,
  resolveWikiNavigation,
} from "./wiki-navigation";

const navigation = [
  {
    type: "tab",
    title: "Documentation",
    slug: "docs",
    children: [
      {
        type: "dropdown",
        title: "Guides",
        children: [
          {
            type: "group",
            title: "Getting Started",
            slug: "guides",
            children: [
              {
                type: "page",
                page: "guides-index",
                slug: "",
                sourcePath: "docs/guides/index",
              },
              {
                type: "page",
                page: "guides-installation",
                slug: "installation",
                sourcePath: "docs/guides/installation",
              },
            ],
          },
        ],
      },
      { type: "dropdown", title: "Blog", href: "https://example.com/blog" },
    ],
  },
  { type: "tab", title: "GitHub", href: "https://github.com/subtopik/topik" },
] satisfies WikiNavigation;

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

test("compiled WikiPage references resolve by name independently of source or public slug", () => {
  const resolved = resolveWikiNavigation(
    [{ type: "page", page: "installation", slug: "getting-started", sourcePath: "moved/install" }],
    { sourceVersion: 1 },
  );
  expect(
    resolveWikiContentHref("ref://wiki-page/installation?view=full#setup", "missing", resolved),
  ).toMatchObject({
    page: { page: "installation" },
    route: "getting-started",
    search: "?view=full",
    hash: "setup",
  });
  expect(resolveWikiContentHref("ref://guide/installation", "installation", resolved)).toBeNull();
  expect(resolveWikiContentHref("ref://wiki-page/missing", "installation", resolved)).toBeNull();
});

test("compiled-reference classification distinguishes missing context from external and Asset links", () => {
  const resolved = resolveWikiNavigation(
    [
      { type: "page", page: "home", slug: "", sourcePath: "pages/home" },
      { type: "page", page: "next", slug: "next", sourcePath: "pages/next" },
    ],
    { sourceVersion: 1 },
  );
  expect(resolveWikiContentReference("next.md?view=a#part", "home", resolved)).toMatchObject({
    kind: "page",
    target: { page: { page: "next" }, search: "?view=a", hash: "part" },
  });
  expect(resolveWikiContentReference("#part", "home", resolved)).toMatchObject({
    kind: "page",
    target: { page: { page: "home" } },
  });
  for (const href of ["#part", "next.md", "missing.md", "file.pdf", "//example.com/path"])
    expect(resolveWikiContentReference(href, "missing-page", resolved)).toEqual({
      kind: "unresolved",
    });
  expect(resolveWikiContentReference("missing.md", "home", resolved)).toEqual({
    kind: "unresolved",
  });
  expect(resolveWikiContentReference("asset:admitted-name", "home", resolved)).toEqual({
    kind: "asset",
  });
  for (const href of [
    "https://topik.invalid/next",
    "https://example.com/path",
    "mailto:a@example.com",
    "tel:123",
  ])
    expect(resolveWikiContentReference(href, "missing-page", resolved)).toEqual({
      kind: "external",
    });
});

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

  test("uses the compiled source path for shorthand nested index pages", () => {
    const shorthand = resolveWikiNavigation([
      {
        type: "page",
        page: "runtime-index",
        slug: "runtime",
        sourcePath: "runtime/index",
      },
      { type: "page", page: "runtime-next", slug: "runtime/next" },
    ]);

    expect(shorthand.pageByName.get("runtime-index")?.sourcePath).toBe("runtime/index");
    expect(resolveWikiContentHref("./next.md", "runtime-index", shorthand)).toMatchObject({
      route: "runtime/next",
    });
  });

  test.each(["/", "/index", "/index.md", "./index.mdx#heading", "index.markdown"])(
    "resolves root index alias %s",
    (href) => {
      const root = resolveWikiNavigation([{ type: "page", page: "home", slug: "" }]);
      expect(resolveWikiContentHref(href, "home", root)).toMatchObject({
        page: { page: "home" },
        route: "",
        hash: href.includes("#") ? "heading" : "",
      });
    },
  );

  test("resolves unique folder landings without shadowing explicit Markdown filenames", () => {
    const pages = [
      { type: "page" as const, page: "home", slug: "home", sourcePath: "home" },
      { type: "page" as const, page: "sibling", slug: "sibling", sourcePath: "files" },
      { type: "page" as const, page: "landing", slug: "landing", sourcePath: "files/index" },
    ];
    const navigation = resolveWikiNavigation(pages, { sourceVersion: 1 });
    for (const href of ["./files", "./files/", "/files/", "./files?view=%FF#heading"])
      expect(resolveWikiContentHref(href, "home", navigation)?.page.page).toBe("landing");
    for (const href of ["./files.md", "/files.md/", "/sibling"])
      expect(resolveWikiContentHref(href, "home", navigation)?.page.page).toBe("sibling");
    const ambiguous = resolveWikiNavigation(
      [...pages, { type: "page", page: "readme", slug: "readme", sourcePath: "files/README" }],
      { sourceVersion: 1 },
    );
    expect(resolveWikiContentHref("./files/", "home", ambiguous)).toBeNull();
    expect(resolveWikiContentHref("./files/index.md", "home", ambiguous)?.page.page).toBe(
      "landing",
    );
  });

  test("distinguishes explicit folders from routes and normalizes encoded paths", () => {
    expect(
      resolveWikiContentHref(
        "/docs/guides/installation/?view=full#setup",
        "guides-index",
        resolved,
      ),
    ).toBeNull();
    expect(
      resolveWikiContentHref("/docs/guides/%69nstallation", "guides-index", resolved),
    ).toMatchObject({ route: "docs/guides/installation" });
  });

  test("rejects non-content and unresolvable links", () => {
    expect(resolveWikiContentHref("custom:opaque", "guides-index", resolved)).toBeNull();
    expect(resolveWikiContentHref("./installation", "unknown", resolved)).toBeNull();
    expect(resolveWikiContentHref("//example.com/docs", "guides-index", resolved)).toBeNull();
    expect(resolveWikiContentHref("/%ZZ", "guides-index", resolved)).toBeNull();
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

test.each([undefined, 1] as const)(
  "exact index routes precede aliases (sourceVersion=%s)",
  (sourceVersion) => {
    const navigation = resolveWikiNavigation(
      [
        { type: "page", page: "home", slug: "", sourcePath: "home" },
        { type: "page", page: "special", slug: "index", sourcePath: "special" },
        { type: "page", page: "section", slug: "section", sourcePath: "section-home" },
        { type: "page", page: "nested", slug: "section/index", sourcePath: "nested" },
      ],
      { sourceVersion },
    );
    for (const [href, target] of [
      ["/", "home"],
      ["/index", "special"],
      ["/section", "section"],
      ["/section/index", "nested"],
      ["/section/index/index", "nested"],
    ]) {
      expect(resolveWikiContentHref(href, "home", navigation)?.page.page).toBe(target);
    }
  },
);

test("Wiki fragments use one encoded spelling for same-page and source-relative links", () => {
  const resolved = resolveWikiNavigation(
    [
      { type: "page", page: "a", slug: "a", sourcePath: "a" },
      { type: "page", page: "b", slug: "b", sourcePath: "b" },
    ],
    { sourceVersion: 1 },
  );
  const local = resolveWikiContentHref("#héllo wörld", "b", resolved);
  const relative = resolveWikiContentHref("./b.md#héllo wörld", "a", resolved);
  expect(local).toMatchObject({ page: { page: "b" }, hash: "h%C3%A9llo%20w%C3%B6rld" });
  expect(relative?.hash).toBe(local?.hash);
  expect(resolveWikiContentHref("#", "b", resolved)?.hash).toBe("");
});

test("rejects duplicate source paths even when page names and routes differ", () => {
  expect(() =>
    resolveWikiNavigation([
      { type: "page", page: "one", slug: "one", sourcePath: "shared" },
      { type: "page", page: "two", slug: "two", sourcePath: "shared" },
    ]),
  ).toThrow("Wiki navigation contains duplicate source paths");
  // A root page without `sourcePath` derives `index`, which collides with an explicit one.
  expect(() =>
    resolveWikiNavigation([
      { type: "page", page: "home", slug: "" },
      { type: "page", page: "other", slug: "other", sourcePath: "index" },
    ]),
  ).toThrow("Wiki navigation contains duplicate source paths");
});

describe("opaque queries", () => {
  const queries = ["?mode=%FF", "?mode=%ff&x=%E2%82", "?q=%", "?q=%2", "?a=%20b&a=c"];
  const pages = [
    { type: "page" as const, page: "a", slug: "a", sourcePath: "dir/a" },
    { type: "page" as const, page: "b", slug: "b", sourcePath: "dir/b" },
    { type: "page" as const, page: "c", slug: "c/x", sourcePath: "folder/index" },
  ];

  test.each(queries)("keeps %s byte-for-byte in every href form", (query) => {
    const resolved = resolveWikiNavigation(pages, { sourceVersion: 1 });
    for (const [href, page] of [
      [`ref://wiki-page/b${query}#h`, "b"],
      [`./b.md${query}#h`, "b"],
      [`b${query}#h`, "b"],
      [`/dir/b.md${query}#h`, "b"],
      [`/b${query}#h`, "b"],
      [`../folder/${query}#h`, "c"],
      [`../folder${query}#h`, "c"],
    ]) {
      expect(resolveWikiContentHref(href, "a", resolved), href).toMatchObject({
        page: { page },
        search: query,
        hash: "h",
      });
    }
  });

  test.each(queries)("keeps %s byte-for-byte without a source version", (query) => {
    const resolved = resolveWikiNavigation(pages);
    for (const href of [`/b${query}`, `../folder/${query}`, `ref://wiki-page/b${query}`])
      expect(resolveWikiContentHref(href, "a", resolved)?.search, href).toBe(query);
  });

  test("encodes raw characters and drops an empty query", () => {
    const resolved = resolveWikiNavigation(pages, { sourceVersion: 1 });
    expect(resolveWikiContentHref("./b.md?a=é#é", "a", resolved)).toMatchObject({
      search: "?a=%C3%A9",
      hash: "%C3%A9",
    });
    expect(resolveWikiContentHref("./b.md?#", "a", resolved)).toMatchObject({
      search: "",
      hash: "",
    });
    expect(resolveWikiContentHref("ref://wiki-page/b?", "a", resolved)?.search).toBe("");
  });
});

test("source-relative links follow the source version", () => {
  const pages = [
    { type: "page" as const, page: "a", slug: "a", sourcePath: "dir/a" },
    { type: "page" as const, page: "b", slug: "b", sourcePath: "dir/b" },
  ];
  const versioned = resolveWikiNavigation(pages, { sourceVersion: 1 });
  const legacy = resolveWikiNavigation(pages);
  // Version 1 matches the source path; without it, the derived route `dir/b` is not declared.
  expect(resolveWikiContentHref("./b.md", "a", versioned)?.page.page).toBe("b");
  expect(resolveWikiContentHref("./b.md", "a", legacy)).toBeNull();
  for (const navigation of [versioned, legacy])
    expect(resolveWikiContentHref("/b", "a", navigation)?.page.page).toBe("b");
});

test("source paths may contain reserved characters and href paths decode once", () => {
  const resolved = resolveWikiNavigation(
    [
      { type: "page", page: "a", slug: "a", sourcePath: "100% sure/a#b?c" },
      { type: "page", page: "b", slug: "b", sourcePath: "100% sure/next page" },
      { type: "page", page: "c", slug: "c", sourcePath: "café" },
    ],
    { sourceVersion: 1 },
  );
  for (const [href, page] of [
    ["./next page.md", "b"],
    ["next%20page.md?x=1#y", "b"],
    ["/100%25%20sure/next%20page.md", "b"],
    ["../café.md", "c"],
    ["../caf%C3%A9.md", "c"],
  ])
    expect(resolveWikiContentHref(href, "a", resolved)?.page.page, href).toBe(page);
  expect(resolveWikiContentHref("./%E2.md", "a", resolved)).toBeNull();
  expect(resolveWikiContentHref("#x", "a", resolved)?.page.page).toBe("a");
});

test("compiled references reject fragments that do not decode", () => {
  const resolved = resolveWikiNavigation([{ type: "page", page: "b", slug: "b", sourcePath: "b" }]);
  expect(resolveWikiContentHref("ref://wiki-page/b#%FF", "missing", resolved)).toBeNull();
  expect(resolveWikiContentHref("ref://wiki-page/b#héllo", "missing", resolved)?.hash).toBe(
    "h%C3%A9llo",
  );
});

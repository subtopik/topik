import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
  resolveWikiContentHref,
  resolveWikiNavigation,
  wikiSchema,
  wikiPageSchema,
} from "@topik/schema";
import { compileWiki, pagePathToName } from "./wiki";

const ajv = new Ajv2020({ strict: true, discriminator: true });
addFormats(ajv);
const validateWiki = ajv.compile(wikiSchema);
const validateWikiPage = ajv.compile(wikiPageSchema);

const pageName = (wikiId: string, pagePath: string) => pagePathToName(wikiId, pagePath);

describe("compileWiki", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeWikiConfig(config: string) {
    await writeFile(join(dir, "wiki.yaml"), config);
  }

  async function writePage(name: string, content: string) {
    await writeFile(join(dir, `${name}.md`), content);
  }

  test("compiles a wiki with pages referenced in nav", async () => {
    await writeWikiConfig(`
id: tw
title: Test Wiki
navigation:
  - hello
`);
    await writePage("hello", "# Hello World\n\nWelcome!");

    const result = await compileWiki({ dir });

    expect(result.resources).toHaveLength(2);

    const page = result.resources.find((r) => r.type === "WikiPage");
    expect(page).toMatchObject({
      apiVersion: "v1",
      type: "WikiPage",
      name: pageName("tw", "hello"),
      spec: {
        wiki: "tw",
        title: "Hello World",
        content: { format: "topik", value: "# Hello World\n\nWelcome!" },
      },
    });

    const wiki = result.resources.find((r) => r.type === "Wiki");
    expect(wiki).toMatchObject({
      apiVersion: "v1",
      type: "Wiki",
      name: "tw",
      spec: {
        title: "Test Wiki",
        navigation: [{ type: "page", page: pageName("tw", "hello"), slug: "hello" }],
      },
    });
  });

  test("only compiles pages referenced in navigation", async () => {
    await writeWikiConfig(`
id: tw
title: Test Wiki
navigation:
  - included
`);
    await writePage("included", "# Included\n");
    await writePage("excluded", "# Excluded\n");

    const result = await compileWiki({ dir });
    const pages = result.resources.filter((r) => r.type === "WikiPage");
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe(pageName("tw", "included"));
  });

  test("collapses index pages in slug", async () => {
    await writeWikiConfig(`
id: tw
title: Test Wiki
navigation:
  - index
  - runtime/index
  - runtime/next
`);
    await writePage("index", "# Home\n");
    await mkdir(join(dir, "runtime"), { recursive: true });
    await writeFile(join(dir, "runtime", "index.md"), "# Runtime\n");
    await writeFile(join(dir, "runtime", "next.md"), "# Next\n");

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    const nav = wiki!.spec.navigation as Array<Record<string, unknown>>;
    expect(nav[0]).toMatchObject({
      page: pageName("tw", "index"),
      slug: "",
      sourcePath: "index",
    });
    expect(nav[1]).toMatchObject({
      page: pageName("tw", "runtime/index"),
      slug: "runtime",
      sourcePath: "runtime/index",
    });

    const resolved = resolveWikiNavigation(wiki!.spec.navigation!);
    expect(
      resolveWikiContentHref("./next.md", pageName("tw", "runtime/index"), resolved),
    ).toMatchObject({ route: "runtime/next" });
  });

  test("uses id from config as resource name", async () => {
    await writeWikiConfig(`
id: my-wiki
title: My Wiki
navigation:
  - page-one
`);
    await writePage("page-one", "# Page One\n");

    const result = await compileWiki({ dir });

    const wiki = result.resources.find((r) => r.type === "Wiki");
    expect(wiki!.name).toBe("my-wiki");

    const page = result.resources.find((r) => r.type === "WikiPage");
    expect(page!.name).toBe(pageName("my-wiki", "page-one"));
    expect(page!.spec.wiki).toBe("my-wiki");
  });

  test("extracts title from markdown heading", async () => {
    await writeWikiConfig("id: test\ntitle: Wiki\nnavigation:\n  - my-page\n");
    await writePage("my-page", "# My Custom Title\n\nContent here.");

    const result = await compileWiki({ dir });
    const page = result.resources.find((r) => r.type === "WikiPage");
    expect(page!.spec.title).toBe("My Custom Title");
  });

  test("falls back to formatted filename when no heading", async () => {
    await writeWikiConfig("id: test\ntitle: Wiki\nnavigation:\n  - getting-started\n");
    await writePage("getting-started", "No heading here, just content.");

    const result = await compileWiki({ dir });
    const page = result.resources.find((r) => r.type === "WikiPage");
    expect(page!.spec.title).toBe("Getting Started");
  });

  test("omits navigation when not configured", async () => {
    await writeWikiConfig("id: test\ntitle: Simple Wiki\n");

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    expect(wiki!.spec).not.toHaveProperty("navigation");
  });

  test("produces no WikiPage resources when no navigation", async () => {
    await writeWikiConfig("id: test\ntitle: Empty Wiki\n");

    const result = await compileWiki({ dir });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].type).toBe("Wiki");
  });

  test("compiles pages in navigation order", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - zebra
  - alpha
`);
    await writePage("zebra", "# Zebra\n");
    await writePage("alpha", "# Alpha\n");

    const result = await compileWiki({ dir });
    const pages = result.resources.filter((r) => r.type === "WikiPage");
    expect(pages.map((p) => p.name)).toEqual([
      pageName("test", "zebra"),
      pageName("test", "alpha"),
    ]);
  });

  test("compiles nested directory pages referenced in nav", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - type: group
    title: Runtime
    slug: runtime
    children:
      - http/server
      - index
`);
    await mkdir(join(dir, "runtime", "http"), { recursive: true });
    await writeFile(join(dir, "runtime", "http", "server.md"), "# HTTP Server\n");
    await writeFile(join(dir, "runtime", "index.md"), "# Runtime\n");

    const result = await compileWiki({ dir });
    const pages = result.resources.filter((r) => r.type === "WikiPage");
    expect(pages.map((p) => p.name)).toEqual([
      pageName("test", "runtime/http/server"),
      pageName("test", "runtime/index"),
    ]);
  });

  test("resolves page paths in navigation to resource names", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - type: group
    title: Runtime
    slug: runtime
    children:
      - http/server
`);
    await mkdir(join(dir, "runtime", "http"), { recursive: true });
    await writeFile(join(dir, "runtime", "http", "server.md"), "# HTTP Server\n");

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    const nav = wiki!.spec.navigation as Array<Record<string, unknown>>;
    const group = nav[0] as { children: Array<Record<string, unknown>> };
    expect(group.children[0]).toMatchObject({
      type: "page",
      page: pageName("test", "runtime/http/server"),
      slug: "http/server",
    });
  });

  test("uses tab, dropdown, and group slugs as filesystem and URL segments", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - type: tab
    title: Documentation
    slug: docs
    children:
      - type: dropdown
        title: Guides
        slug: guides
        children:
          - type: group
            title: Getting Started
            slug: getting-started
            children:
              - index
              - type: page
                slug: installation
`);
    const pageDir = join(dir, "docs", "guides", "getting-started");
    await mkdir(pageDir, { recursive: true });
    await writeFile(join(pageDir, "index.md"), "# Getting Started\n");
    await writeFile(join(pageDir, "installation.md"), "# Installation\n");

    const result = await compileWiki({ dir });
    const pages = result.resources.filter((resource) => resource.type === "WikiPage");
    expect(pages.map((page) => page.name)).toEqual([
      pageName("test", "docs/guides/getting-started/index"),
      pageName("test", "docs/guides/getting-started/installation"),
    ]);

    const wiki = result.resources.find((resource) => resource.type === "Wiki")!;
    const tab = wiki.spec.navigation![0];
    expect(tab).toMatchObject({ type: "tab", slug: "docs" });
    if (tab.type !== "tab" || !("children" in tab)) throw new Error("Expected tab");
    const dropdown = tab.children[0];
    expect(dropdown).toMatchObject({ type: "dropdown", slug: "guides" });
    if (dropdown.type !== "dropdown" || !("children" in dropdown)) {
      throw new Error("Expected dropdown");
    }
    const group = dropdown.children[0];
    if (group.type !== "group") throw new Error("Expected group");
    expect(group.children).toEqual([
      {
        type: "page",
        page: pageName("test", "docs/guides/getting-started/index"),
        slug: "",
        sourcePath: "docs/guides/getting-started/index",
      },
      {
        type: "page",
        page: pageName("test", "docs/guides/getting-started/installation"),
        slug: "installation",
        sourcePath: "docs/guides/getting-started/installation",
      },
    ]);
  });

  test("pathless containers do not contribute to filesystem or URL paths", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - type: tab
    title: Documentation
    children:
      - type: dropdown
        title: Guides
        children:
          - type: group
            title: Getting Started
            children:
              - overview
`);
    await writePage("overview", "# Overview\n");

    const result = await compileWiki({ dir });
    const page = result.resources.find((resource) => resource.type === "WikiPage")!;
    expect(page.name).toBe(pageName("test", "overview"));

    const wiki = result.resources.find((resource) => resource.type === "Wiki")!;
    const tab = wiki.spec.navigation![0];
    expect(tab).not.toHaveProperty("slug");
    if (tab.type !== "tab" || !("children" in tab)) throw new Error("Expected tab");
    const dropdown = tab.children[0];
    expect(dropdown).not.toHaveProperty("slug");
    if (dropdown.type !== "dropdown" || !("children" in dropdown)) {
      throw new Error("Expected dropdown");
    }
    const group = dropdown.children[0];
    expect(group).not.toHaveProperty("slug");
    if (group.type !== "group") throw new Error("Expected group");
    expect(group.children[0]).toEqual({
      type: "page",
      page: pageName("test", "overview"),
      slug: "overview",
      sourcePath: "overview",
    });
  });

  test("generates slug from page path", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - getting-started
`);
    await writePage("getting-started", "# Getting Started\n");

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    const nav = wiki!.spec.navigation as Array<Record<string, unknown>>;
    expect(nav[0]).toMatchObject({
      type: "page",
      page: pageName("test", "getting-started"),
      slug: "getting-started",
    });
  });

  test("requires and compiles a group slug", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - type: group
    title: Getting Started
    slug: getting-started
    children: []
`);

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    const nav = wiki!.spec.navigation as Array<Record<string, unknown>>;
    expect(nav[0]).toMatchObject({
      type: "group",
      title: "Getting Started",
      slug: "getting-started",
    });
  });

  test("compiles link nav nodes", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - type: link
    title: Example
    href: https://example.com
    icon: globe
`);

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    const nav = wiki!.spec.navigation as Array<Record<string, unknown>>;
    expect(nav[0]).toMatchObject({
      type: "link",
      title: "Example",
      href: "https://example.com",
      icon: "globe",
    });
  });

  test("supports .mdx files", async () => {
    await writeWikiConfig("id: test\ntitle: Wiki\nnavigation:\n  - intro\n");
    await writeFile(join(dir, "intro.mdx"), "---\ntitle: Introduction\n---\n\nSome MDX content.");

    const result = await compileWiki({ dir });
    const page = result.resources.find((r) => r.type === "WikiPage");
    expect(page!.name).toBe(pageName("test", "intro"));
    expect(page!.spec.title).toBe("Introduction");
  });

  test("uses frontmatter title over heading", async () => {
    await writeWikiConfig("id: test\ntitle: Wiki\nnavigation:\n  - page\n");
    await writeFile(
      join(dir, "page.md"),
      "---\ntitle: Frontmatter Title\n---\n\n# Heading Title\n",
    );

    const result = await compileWiki({ dir });
    const page = result.resources.find((r) => r.type === "WikiPage");
    expect(page!.spec.title).toBe("Frontmatter Title");
  });

  test("extracts description from page frontmatter", async () => {
    await writeWikiConfig("id: test\ntitle: Wiki\nnavigation:\n  - page\n");
    await writeFile(
      join(dir, "page.md"),
      "---\ndescription: A concise overview of the page.\n---\n\n# Page\n",
    );

    const result = await compileWiki({ dir });
    const page = result.resources.find((r) => r.type === "WikiPage");
    expect(page!.spec.description).toBe("A concise overview of the page.");
  });

  test("truncates overlong page frontmatter descriptions", async () => {
    await writeWikiConfig("id: test\ntitle: Wiki\nnavigation:\n  - page\n");
    await writeFile(join(dir, "page.md"), `---\ndescription: ${"a".repeat(1025)}\n---\n\n# Page\n`);

    const result = await compileWiki({ dir });
    const page = result.resources.find((r) => r.type === "WikiPage");
    expect(page!.spec.description).toBe("a".repeat(1024));
  });

  test("includes description from wiki config", async () => {
    await writeWikiConfig("id: test\ntitle: Wiki\ndescription: Documentation for Topik.\n");

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    expect(wiki!.spec.description).toBe("Documentation for Topik.");
  });

  test("extracts local image references as Asset resources", async () => {
    await writeWikiConfig("id: tw\ntitle: Wiki\nnavigation:\n  - hello\n");
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
      "hex",
    );
    await writeFile(join(dir, "hero.png"), png);
    await writePage("hello", "# Hello\n\n![hero](./hero.png)\n");

    const result = await compileWiki({ dir });
    const assets = result.resources.filter((r) => r.type === "Asset");
    const page = result.resources.find((r) => r.type === "WikiPage")!;

    expect(assets).toHaveLength(1);
    expect(assets[0].name).toMatch(/^[a-f0-9]{16}$/);
    expect(page.spec.content.value).toContain(`![hero](asset:${assets[0].name})`);
    expect(page.spec.assets).toEqual([assets[0].name]);
  });

  test("extracts local asset references from valid Topik tags", async () => {
    await writeWikiConfig("id: tw\ntitle: Wiki\nnavigation:\n  - hello\n");
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
      "hex",
    );
    await writeFile(join(dir, "hero.png"), png);
    await writePage("hello", '# Hello\n\n{% figure src="./hero.png" alt="Hero" /%}\n');

    const result = await compileWiki({ dir });
    const assets = result.resources.filter((r) => r.type === "Asset");
    const page = result.resources.find((r) => r.type === "WikiPage")!;

    expect(assets).toHaveLength(1);
    expect(page.spec.content.value).toContain(`src="asset:${assets[0].name}"`);
    expect(page.spec.assets).toEqual([assets[0].name]);
  });

  test("validates same-page and cross-page heading links", async () => {
    await writeWikiConfig("id: tw\ntitle: Wiki\nnavigation:\n  - intro\n  - setup\n");
    await writePage(
      "intro",
      "# Introduction\n\n[Local](#overview)\n\n[Install](./setup.md#install)\n\n## Overview\n",
    );
    await writePage("setup", "# Setup\n\n## Install\n");

    const result = await compileWiki({ dir });

    expect(result.diagnostics).toEqual([]);
  });

  test("resolves root, nested, and nested-index links from their source paths", async () => {
    await writeWikiConfig(`
id: tw
title: Wiki
navigation:
  - index
  - root
  - type: group
    title: Runtime
    slug: runtime
    children:
      - index
      - child
      - sibling
`);

    const pages = [
      ["index.md", "# Home\n\n[Root](./root.md#root)\n\n[Runtime](/runtime/#runtime)\n\n## Home\n"],
      ["root.md", "# Root\n\n[Home](/index.md#home)\n\n## Root\n"],
      [
        "runtime/index.md",
        [
          "# Runtime",
          "",
          "[Child](./child.mdx?mode=full#child)",
          "",
          "[Root](../root.md#root)",
          "",
          '{% card title="Child card" href="./child.md#child" /%}',
          "",
          "## Runtime",
          "",
        ].join("\n"),
      ],
      ["runtime/child.mdx", "# Child\n\n[Sibling](./sibling.md#sibling)\n\n## Child\n"],
      ["runtime/sibling.md", "# Sibling\n\n## Sibling\n"],
    ] as const;

    for (const [path, content] of pages) {
      const filePath = join(dir, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }

    await expect(compileWiki({ dir })).resolves.toMatchObject({ diagnostics: [] });
  });

  test("fails compilation for missing internal pages and fragments by default", async () => {
    await writeWikiConfig("id: tw\ntitle: Wiki\nnavigation:\n  - intro\n  - setup\n");
    await writePage(
      "intro",
      "# Introduction\n\n[Missing page](/absent)\n\n[Missing heading](/setup#absent)\n",
    );
    await writePage("setup", "# Setup\n");

    await expect(compileWiki({ dir })).rejects.toThrow(/link-page-not-found/);
    await expect(compileWiki({ dir })).rejects.toThrow(/link-fragment-not-found/);
  });

  test("can downgrade unresolved internal links to warnings", async () => {
    await writeWikiConfig("id: tw\ntitle: Wiki\nnavigation:\n  - intro\n");
    await writePage("intro", "# Introduction\n\n[Missing](/absent#heading)\n");

    const result = await compileWiki({ dir, validation: { links: "warning" } });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ id: "link-page-not-found", level: "warning" }),
    ]);
  });

  test("can skip unresolved internal link validation", async () => {
    await writeWikiConfig("id: tw\ntitle: Wiki\nnavigation:\n  - intro\n");
    await writePage("intro", "# Introduction\n\n[Missing](/absent#heading)\n");

    const result = await compileWiki({ dir, validation: { links: "off" } });

    expect(result.diagnostics).toEqual([]);
  });

  test("rejects unsafe card links even when target validation is off", async () => {
    await writeWikiConfig("id: tw\ntitle: Wiki\nnavigation:\n  - intro\n");
    await writePage(
      "intro",
      '# Introduction\n\n{% card title="Unsafe" href="javascript:alert(1)" /%}\n',
    );

    await expect(compileWiki({ dir, validation: { links: "off" } })).rejects.toThrow(
      /link-scheme-unsafe/,
    );
  });

  test("rejects invalid Topik content in wiki pages", async () => {
    await writeWikiConfig("id: tw\ntitle: Wiki\nnavigation:\n  - hello\n");
    await writePage("hello", '# Hello\n\n{% card href="/docs" /%}\n');

    await expect(compileWiki({ dir })).rejects.toThrow(
      /hello\.md:[\s\S]*attribute-missing-required/,
    );
  });

  test("throws when referenced page file is missing", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - nonexistent
`);

    await expect(compileWiki({ dir })).rejects.toThrow("Page not found: nonexistent");
  });

  test("returns no resources when the wiki config is missing", async () => {
    await writePage("hello", "# Hello\n");

    await expect(compileWiki({ dir })).resolves.toEqual({ diagnostics: [], resources: [] });
  });

  test("rejects navigation page paths that cannot become wiki page names", async () => {
    await writeWikiConfig("id: test\ntitle: Wiki\nnavigation:\n  - Runtime/Hello_World\n");

    await expect(compileWiki({ dir })).rejects.toThrow(
      "Wiki page paths must use lowercase DNS-style segments separated by '/'",
    );
  });

  test("throws when the wiki id is too long for hashed page names", async () => {
    await writeWikiConfig(
      ["id: " + "a".repeat(47), "title: Wiki", "navigation:", "  - intro", ""].join("\n"),
    );
    await writePage("intro", "# Intro\n");

    await expect(compileWiki({ dir })).rejects.toThrow("Wiki id must be 46 characters or fewer");
  });
});

describe("pagePathToName", () => {
  test("generates a hash-based DNS-compatible name scoped to the wiki", () => {
    expect(pagePathToName("docs", "runtime/http/server")).toMatch(/^docs-[a-f0-9]{16}$/);
  });

  test("normalizes leading slashes and markdown extensions", () => {
    expect(pagePathToName("docs", "/runtime/index.md")).toBe(
      pagePathToName("docs", "runtime/index"),
    );
  });

  test("scopes the full resource name with the wiki id prefix", () => {
    const docsName = pagePathToName("docs", "introduction");
    const otherName = pagePathToName("other", "introduction");

    expect(docsName).toMatch(/^docs-/);
    expect(otherName).toMatch(/^other-/);
    expect(docsName.split("-").at(-1)).toBe(otherName.split("-").at(-1));
  });

  test("fits the schema name limit", () => {
    const name = pagePathToName(
      "scatool-docs",
      "administration-collaboration-account/members-and-role-management",
    );
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("uses the full wiki id prefix at the exact prefix boundary", () => {
    const wikiId = "a".repeat(46);
    const name = pagePathToName(wikiId, "introduction");

    expect(name).toMatch(new RegExp(`^${wikiId}-[a-f0-9]{16}$`));
    expect(name.length).toBe(63);
  });
});

describe("schema validation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-schema-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("compiled Wiki resource validates against schema", async () => {
    await writeFile(
      join(dir, "wiki.yaml"),
      `
id: test-wiki
title: Test Wiki
description: Test wiki description.
theme:
  colors:
    primary: "#ff73a8"
  appearance:
    default: system
navigation:
  - type: tab
    title: Runtime
    slug: runtime
    icon: cog
    children:
      - type: group
        title: Get Started
        slug: get-started
        icon: terminal
        children:
          - intro
          - getting-started
  - type: tab
    title: GitHub
    href: https://github.com
    icon: globe
`,
    );
    await mkdir(join(dir, "runtime", "get-started"), { recursive: true });
    await writeFile(join(dir, "runtime", "get-started", "intro.md"), "# Introduction\n\nWelcome.");
    await writeFile(
      join(dir, "runtime", "get-started", "getting-started.md"),
      "# Getting Started\n\nLet's go.",
    );

    const { resources } = await compileWiki({ dir });
    const wiki = resources.find((r) => r.type === "Wiki")!;

    const valid = validateWiki(wiki);
    if (!valid) {
      console.error(validateWiki.errors);
    }
    expect(valid).toBe(true);
  });

  test("compiled WikiPage resources validate against schema", async () => {
    await writeFile(
      join(dir, "wiki.yaml"),
      "id: test-wiki\ntitle: Wiki\nnavigation:\n  - hello\n  - with-frontmatter\n",
    );
    await writeFile(join(dir, "hello.md"), "# Hello\n\nContent here.");
    await writeFile(
      join(dir, "with-frontmatter.mdx"),
      "---\ntitle: Custom Title\ndescription: Custom description\n---\n\nMDX content.",
    );

    const { resources } = await compileWiki({ dir });
    const pages = resources.filter((r) => r.type === "WikiPage");

    expect(pages.length).toBe(2);
    for (const page of pages) {
      const valid = validateWikiPage(page);
      if (!valid) {
        console.error(validateWikiPage.errors);
      }
      expect(valid).toBe(true);
    }
  });

  test("compiled resources with nested paths validate against schema", async () => {
    await writeFile(
      join(dir, "wiki.yaml"),
      `
id: test-wiki
title: Wiki
navigation:
  - type: group
    title: Runtime
    slug: runtime
    children:
      - http/server
`,
    );
    await mkdir(join(dir, "runtime", "http"), { recursive: true });
    await writeFile(join(dir, "runtime", "http", "server.md"), "# HTTP Server\n");

    const { resources } = await compileWiki({ dir });

    const wiki = resources.find((r) => r.type === "Wiki")!;
    expect(validateWiki(wiki)).toBe(true);

    const page = resources.find((r) => r.type === "WikiPage")!;
    expect(validateWikiPage(page)).toBe(true);
  });
});

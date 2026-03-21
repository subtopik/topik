import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { wikiSchema, wikiPageSchema } from "@topik/schema";
import { compileWiki, pagePathToName } from "./wiki";

const ajv = new Ajv2020({ strict: true, discriminator: true });
addFormats(ajv);
const validateWiki = ajv.compile(wikiSchema);
const validateWikiPage = ajv.compile(wikiPageSchema);

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
      name: "tw-hello",
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
        navigation: [{ type: "page", page: "tw-hello", slug: "hello" }],
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
    expect(pages[0].name).toBe("tw-included");
  });

  test("collapses index pages in slug", async () => {
    await writeWikiConfig(`
id: tw
title: Test Wiki
navigation:
  - index
  - runtime/index
`);
    await writePage("index", "# Home\n");
    await mkdir(join(dir, "runtime"), { recursive: true });
    await writeFile(join(dir, "runtime", "index.md"), "# Runtime\n");

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    const nav = wiki!.spec.navigation as Array<Record<string, unknown>>;
    expect(nav[0]).toMatchObject({ page: "tw-index", slug: "" });
    expect(nav[1]).toMatchObject({ page: "tw-runtime-index", slug: "runtime" });
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
    expect(page!.name).toBe("my-wiki-page-one");
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
    expect(pages.map((p) => p.name)).toEqual(["test-zebra", "test-alpha"]);
  });

  test("compiles nested directory pages referenced in nav", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - group: Runtime
    children:
      - runtime/http/server
      - runtime/index
`);
    await mkdir(join(dir, "runtime", "http"), { recursive: true });
    await writeFile(join(dir, "runtime", "http", "server.md"), "# HTTP Server\n");
    await writeFile(join(dir, "runtime", "index.md"), "# Runtime\n");

    const result = await compileWiki({ dir });
    const pages = result.resources.filter((r) => r.type === "WikiPage");
    expect(pages.map((p) => p.name)).toEqual(["test-runtime-http-server", "test-runtime-index"]);
  });

  test("resolves page paths in navigation to resource names", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - group: Runtime
    children:
      - runtime/http/server
`);
    await mkdir(join(dir, "runtime", "http"), { recursive: true });
    await writeFile(join(dir, "runtime", "http", "server.md"), "# HTTP Server\n");

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    const nav = wiki!.spec.navigation as Array<Record<string, unknown>>;
    const group = nav[0] as { children: Array<Record<string, unknown>> };
    expect(group.children[0]).toMatchObject({
      type: "page",
      page: "test-runtime-http-server",
      slug: "runtime/http/server",
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
      page: "test-getting-started",
      slug: "getting-started",
    });
  });

  test("groups have no slug by default", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - group: Getting Started
    children: []
`);

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    const nav = wiki!.spec.navigation as Array<Record<string, unknown>>;
    expect(nav[0]).toMatchObject({ type: "group", title: "Getting Started" });
    expect(nav[0]).not.toHaveProperty("slug");
  });

  test("supports explicit slug on group", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - group: Getting Started
    slug: start
    children: []
`);

    const result = await compileWiki({ dir });
    const wiki = result.resources.find((r) => r.type === "Wiki");
    const nav = wiki!.spec.navigation as Array<Record<string, unknown>>;
    expect(nav[0]).toMatchObject({ slug: "start" });
  });

  test("compiles link nav nodes", async () => {
    await writeWikiConfig(`
id: test
title: Wiki
navigation:
  - href: https://example.com
    title: Example
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
    expect(page!.name).toBe("test-intro");
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

    await expect(compileWiki({ dir })).resolves.toEqual({ resources: [] });
  });

  test("rejects navigation page paths that cannot become wiki page names", async () => {
    await writeWikiConfig("id: test\ntitle: Wiki\nnavigation:\n  - Runtime/Hello_World\n");

    await expect(compileWiki({ dir })).rejects.toThrow(
      "Wiki page paths must use lowercase DNS-style segments separated by '/'",
    );
  });
});

describe("pagePathToName", () => {
  test("converts path to DNS-compatible name", () => {
    expect(pagePathToName("runtime/http/server")).toBe("runtime-http-server");
  });

  test("strips leading slash", () => {
    expect(pagePathToName("/runtime/index")).toBe("runtime-index");
  });

  test("passes through simple names", () => {
    expect(pagePathToName("introduction")).toBe("introduction");
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
theme:
  colors:
    primary: "#ff73a8"
  appearance:
    default: system
navigation:
  - tab: Runtime
    icon: cog
    children:
      - group: Get Started
        icon: terminal
        children:
          - intro
          - getting-started
      - href: https://github.com
        title: GitHub
        icon: globe
`,
    );
    await writeFile(join(dir, "intro.md"), "# Introduction\n\nWelcome.");
    await writeFile(join(dir, "getting-started.md"), "# Getting Started\n\nLet's go.");

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
      "---\ntitle: Custom Title\n---\n\nMDX content.",
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
  - group: Runtime
    children:
      - runtime/http/server
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

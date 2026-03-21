import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { LoaderContext } from "astro/loaders";
import { topikWikiLoader } from "./wiki";

const fixturesDir = join(import.meta.dirname, "__fixtures__/docs");

function createMockContext() {
  const entries = new Map<string, { id: string; data: Record<string, unknown>; body?: string }>();
  return {
    store: {
      clear: () => entries.clear(),
      set: (entry: {
        id: string;
        data: Record<string, unknown>;
        body?: string;
        digest?: string;
      }) => {
        entries.set(entry.id, entry);
      },
    },
    logger: { info: () => {} },
    generateDigest: (data: string) => String(data.length),
    entries,
  } as unknown as LoaderContext & { entries: typeof entries };
}

describe("topikWikiLoader", () => {
  test("returns a loader with the correct name", () => {
    const loader = topikWikiLoader({ dir: fixturesDir });
    expect(loader.name).toBe("topik-wiki");
  });

  test("loads wiki pages from a directory", async () => {
    const loader = topikWikiLoader({ dir: fixturesDir });
    const ctx = createMockContext();
    await loader.load(ctx);

    expect(ctx.entries.size).toBe(3);
  });

  test("populates wiki page entries with correct data", async () => {
    const loader = topikWikiLoader({ dir: fixturesDir });
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("docs-introduction");
    expect(entry).toBeDefined();
    expect(entry!.data.title).toBe("Introduction");
    expect(entry!.data.wiki).toBe("docs");
    expect(entry!.data.slug).toBe("introduction");
  });

  test("resolves slugs from navigation for nested pages", async () => {
    const loader = topikWikiLoader({ dir: fixturesDir });
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("docs-getting-started-installation");
    expect(entry).toBeDefined();
    expect(entry!.data.slug).toBe("getting-started/installation");
  });

  test("includes body content", async () => {
    const loader = topikWikiLoader({ dir: fixturesDir });
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("docs-introduction");
    expect(entry!.body).toContain("# Introduction");
  });

  test("exposes navigation tree after loading", async () => {
    const loader = topikWikiLoader({ dir: fixturesDir });
    const ctx = createMockContext();

    await expect(loader.getNavigation()).resolves.toEqual([
      {
        type: "page",
        page: "docs-introduction",
        slug: "introduction",
      },
      {
        type: "group",
        title: "Getting Started",
        children: [
          {
            type: "page",
            page: "docs-getting-started-installation",
            slug: "getting-started/installation",
          },
          {
            type: "page",
            page: "docs-getting-started-configuration",
            slug: "getting-started/configuration",
          },
        ],
      },
    ]);

    await loader.load(ctx);

    const nav = await loader.getNavigation();
    expect(nav.length).toBe(2);
    expect(nav[0]).toEqual({
      type: "page",
      page: "docs-introduction",
      slug: "introduction",
    });
    expect(nav[1]).toMatchObject({
      type: "group",
      title: "Getting Started",
    });
  });
});

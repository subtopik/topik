import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { LoaderContext } from "astro/loaders";
import { topikWikiLoader } from "./wiki";

const docsDir = join(import.meta.dirname, "../../../docs");
const wikiPageNamePattern = /^topik-docs-[a-f0-9]{16}$/;

function createMockContext() {
  const entries = new Map<string, { id: string; data: Record<string, unknown>; body?: string }>();
  return {
    store: {
      clear: () => entries.clear(),
      set: (entry: { id: string; data: Record<string, unknown>; body?: string; digest?: string }) =>
        entries.set(entry.id, entry),
    },
    logger: { info: () => {} },
    generateDigest: (data: string) => String(data.length),
    entries,
  } as unknown as LoaderContext & { entries: typeof entries };
}

describe("topikWikiLoader", () => {
  test("returns a loader with the correct name", () => {
    expect(topikWikiLoader({ dir: docsDir }).name).toBe("topik-wiki");
  });

  test("loads the self-hosted Topik wiki", async () => {
    const loader = topikWikiLoader({ dir: docsDir });
    const context = createMockContext();
    await loader.load(context);

    expect(context.entries.size).toBe(4);
    const home = [...context.entries.values()].find((entry) => entry.data.slug === "");
    expect(home).toMatchObject({
      id: expect.stringMatching(wikiPageNamePattern),
      data: { title: "Topik", wiki: "topik-docs", slug: "" },
    });
    expect(home?.body).toContain("# Topik");
  });

  test("uses the shared resolver for pathless container routes", async () => {
    const loader = topikWikiLoader({ dir: docsDir });
    const context = createMockContext();
    await loader.load(context);

    expect([...context.entries.values()].map((entry) => entry.data.slug)).toEqual([
      "",
      "resources",
      "navigation",
      "rendering",
    ]);
  });

  test("exposes the compiled navigation tree", async () => {
    const navigation = await topikWikiLoader({ dir: docsDir }).getNavigation();
    expect(navigation).toEqual([
      {
        type: "page",
        page: expect.stringMatching(wikiPageNamePattern),
        slug: "",
      },
      {
        type: "group",
        title: "Concepts",
        children: [
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "resources",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "navigation",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "rendering",
          },
        ],
      },
    ]);
  });
});

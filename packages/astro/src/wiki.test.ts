import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { LoaderContext } from "astro/loaders";
import { topikWikiLoader } from "./wiki";

const docsDir = join(import.meta.dirname, "../../../docs");
const wikiPageNamePattern = /^topik-docs-[a-f0-9]{16}$/;
const docsOptions = { dir: docsDir, sourceNamespace: "astro-docs-fixture" } as const;
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

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
    expect(topikWikiLoader(docsOptions).name).toBe("topik-wiki");
  });

  test("loads the self-hosted Topik wiki", async () => {
    const loader = topikWikiLoader(docsOptions);
    const context = createMockContext();
    await loader.load(context);

    expect(context.entries.size).toBe(5);
    const home = [...context.entries.values()].find((entry) => entry.data.slug === "");
    expect(home).toMatchObject({
      id: expect.stringMatching(wikiPageNamePattern),
      data: { title: "Topik", wiki: "topik-docs", slug: "" },
    });
    expect(home?.body).toContain("# Topik");
  });

  test("uses the shared resolver for pathless container routes", async () => {
    const loader = topikWikiLoader(docsOptions);
    const context = createMockContext();
    await loader.load(context);

    expect([...context.entries.values()].map((entry) => entry.data.slug)).toEqual([
      "",
      "resources",
      "assets",
      "navigation",
      "rendering",
    ]);
  });

  test("exposes the compiled navigation tree", async () => {
    const navigation = await topikWikiLoader(docsOptions).getNavigation();
    expect(navigation).toEqual([
      {
        type: "page",
        page: expect.stringMatching(wikiPageNamePattern),
        slug: "",
        sourcePath: "index",
      },
      {
        type: "group",
        title: "Concepts",
        children: [
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "resources",
            sourcePath: "resources",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "navigation",
            sourcePath: "navigation",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "rendering",
            sourcePath: "rendering",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "assets",
            sourcePath: "assets",
          },
        ],
      },
    ]);
  });

  test("loads shorthand nested index pages with canonical routes and source paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "topik-astro-wiki-"));
    try {
      await writeFile(
        join(dir, "wiki.yaml"),
        "id: docs\ntitle: Docs\nnavigation:\n  - runtime/index\n  - runtime/next\n",
      );
      await mkdir(join(dir, "runtime"));
      await writeFile(join(dir, "runtime", "index.md"), "# Runtime\n");
      await writeFile(join(dir, "runtime", "next.md"), "# Next\n");

      const loader = topikWikiLoader({ dir, sourceNamespace: "astro-nested-wiki" });
      const context = createMockContext();
      await loader.load(context);

      expect([...context.entries.values()].map((entry) => entry.data.slug)).toEqual([
        "runtime",
        "runtime/next",
      ]);
      expect(await loader.getNavigation()).toEqual([
        {
          type: "page",
          page: expect.stringMatching(/^docs-[a-f0-9]{16}$/),
          slug: "runtime",
          sourcePath: "runtime/index",
        },
        {
          type: "page",
          page: expect.stringMatching(/^docs-[a-f0-9]{16}$/),
          slug: "runtime/next",
          sourcePath: "runtime/next",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains compiler-emitted Asset descriptors and resolves rewritten Wiki content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "topik-astro-wiki-assets-"));
    try {
      await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
      await writeFile(join(dir, "hero.png"), PNG_BYTES);
      await writeFile(join(dir, "manual.pdf"), "%PDF-1.7\nmanual\n");
      await writeFile(
        join(dir, "intro.md"),
        "# Intro\n\n![Hero](hero.png)\n\n[Manual](manual.pdf)\n",
      );
      const loader = topikWikiLoader({ dir, sourceNamespace: "astro-wiki-assets" });
      const context = createMockContext();

      await loader.load(context);

      const body = [...context.entries.values()][0]?.body ?? "";
      const assets = loader.getAssets();
      expect(assets).toHaveLength(2);
      expect(body.match(/asset:auto-v1-[a-z2-7]{51}[aq]/gu)).toHaveLength(2);
      expect(assets.map((asset) => asset.spec.mediaType).sort()).toEqual([
        "application/pdf",
        "image/png",
      ]);
      for (const asset of assets) {
        expect(loader.resolveAsset(asset.name)).toBe(`/${asset.spec.uri}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

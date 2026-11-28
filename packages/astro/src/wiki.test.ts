import { createProjectAssetNameGenerator } from "@topik/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { LoaderContext } from "astro/loaders";
import { topikWikiLoader } from "./wiki";

const docsDir = join(import.meta.dirname, "../../../docs");
// Compiling all of docs/ takes a few seconds on a loaded CI runner and grows with the docs.
const DOCS_COMPILE = { timeout: 30_000 };
const wikiPageNamePattern = /^topik-docs-[a-f0-9]{16}$/;
const docsOptions = {
  dir: docsDir,
  name: "astro-docs-fixture",
  assets: {
    generateName: createProjectAssetNameGenerator({
      projectRoot: docsDir,
      projectNamespace: "astro-docs-fixture",
    }),
  },
} as const;
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function createMockContext() {
  const entries = new Map<
    string,
    { id: string; data: Record<string, unknown>; body?: string; digest?: string }
  >();
  return {
    store: {
      clear: () => entries.clear(),
      set: (entry: { id: string; data: Record<string, unknown>; body?: string; digest?: string }) =>
        entries.set(entry.id, entry),
    },
    logger: { info: () => {} },
    generateDigest: (data: string) => data,
    entries,
  } as unknown as LoaderContext & { entries: typeof entries };
}

describe("topikWikiLoader", () => {
  test("returns a loader with the correct name", () => {
    expect(topikWikiLoader(docsOptions).name).toBe(docsOptions.name);
  });

  test("rejects an empty loader name", () => {
    expect(() => topikWikiLoader({ dir: docsDir, name: " " })).toThrow(/loader name/u);
  });

  test(
    "loads content without a manifest or naming callback when there are no local assets",
    DOCS_COMPILE,
    async () => {
      const loader = topikWikiLoader({ dir: docsDir, name: "docs-without-assets" });
      const context = createMockContext();
      await loader.load(context);
      expect(context.entries.size).toBe(11);
      expect(loader.getAssets()).toEqual([]);
    },
  );

  test("loads the self-hosted Topik wiki", DOCS_COMPILE, async () => {
    const loader = topikWikiLoader(docsOptions);
    const context = createMockContext();
    await loader.load(context);

    expect(context.entries.size).toBe(11);
    const home = [...context.entries.values()].find((entry) => entry.data.slug === "");
    expect(home).toMatchObject({
      id: expect.stringMatching(wikiPageNamePattern),
      data: { title: "Topik", wiki: "topik-docs", slug: "" },
    });
    expect(home?.body).toContain("# Topik");
  });

  test("uses the shared resolver for nested documentation routes", DOCS_COMPILE, async () => {
    const loader = topikWikiLoader(docsOptions);
    const context = createMockContext();
    await loader.load(context);

    const slugs = [...context.entries.values()].map((entry) => String(entry.data.slug));
    expect(slugs.sort((a, b) => a.localeCompare(b))).toEqual([
      "",
      "content/autolinks",
      "content/code-presentation",
      "content/content-design",
      "content/rendering",
      "content/templates",
      "resources",
      "resources/assets",
      "resources/manifest",
      "resources/navigation",
      "resources/source-writing",
    ]);
  });

  test("exposes the compiled navigation tree", DOCS_COMPILE, async () => {
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
        title: "Content",
        slug: "content",
        children: [
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "content-design",
            sourcePath: "content/content-design",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "autolinks",
            sourcePath: "content/autolinks",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "templates",
            sourcePath: "content/templates",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "code-presentation",
            sourcePath: "content/code-presentation",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "rendering",
            sourcePath: "content/rendering",
          },
        ],
      },
      {
        type: "group",
        title: "Resources",
        slug: "resources",
        children: [
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "",
            sourcePath: "resources/index",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "navigation",
            sourcePath: "resources/navigation",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "manifest",
            sourcePath: "resources/manifest",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "source-writing",
            sourcePath: "resources/source-writing",
          },
          {
            type: "page",
            page: expect.stringMatching(wikiPageNamePattern),
            slug: "assets",
            sourcePath: "resources/assets",
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

      const loader = topikWikiLoader({
        dir,
        name: "astro-nested-wiki",
        assets: {
          generateName: createProjectAssetNameGenerator({
            projectRoot: dir,
            projectNamespace: "astro-nested-wiki",
          }),
        },
      });
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
      const loader = topikWikiLoader({
        dir,
        name: "astro-wiki-assets",
        assets: {
          generateName: createProjectAssetNameGenerator({
            projectRoot: dir,
            projectNamespace: "astro-wiki-assets",
          }),
        },
      });
      const context = createMockContext();

      await loader.load(context);

      const body = [...context.entries.values()][0]?.body ?? "";
      const assets = loader.getAssets();
      expect(assets).toHaveLength(2);
      expect(body.match(/asset:auto-v1-[a-z2-7]{51}[aq]/gu)).toHaveLength(2);
      expect(
        assets.map((asset) => asset.spec.mediaType).sort((a, b) => a.localeCompare(b)),
      ).toEqual(["application/pdf", "image/png"]);
      for (const asset of assets) {
        expect(loader.resolveAsset(asset.name)).toBe(`/${asset.spec.uri}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("includes page metadata in entry digests so metadata edits invalidate the cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "topik-astro-wiki-digest-"));
    try {
      await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
      await writeFile(
        join(dir, "intro.md"),
        "---\ntitle: Before\ndescription: Initial\n---\nBody text.\n",
      );
      const loader = topikWikiLoader({ dir, name: "astro-wiki-digest" });
      const context = createMockContext();
      await loader.load(context);
      const before = [...context.entries.values()][0];
      expect(before?.body).toBe("Body text.\n");

      await writeFile(
        join(dir, "intro.md"),
        "---\ntitle: After\ndescription: Updated\n---\nBody text.\n",
      );
      await loader.load(context);
      const after = [...context.entries.values()][0];
      expect(after?.body).toBe(before?.body);
      expect(after?.digest).not.toBe(before?.digest);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scopes published navigation by source directory and clears it on failed reloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "topik-astro-wiki-scope-"));
    const dirA = join(root, "wiki-a");
    const dirB = join(root, "wiki-b");
    try {
      await mkdir(dirA);
      await mkdir(dirB);
      await writeFile(join(dirA, "wiki.yaml"), "id: a\ntitle: Wiki A\nnavigation:\n  - alpha\n");
      await writeFile(join(dirA, "alpha.md"), "# Alpha\n");
      await writeFile(join(dirB, "wiki.yaml"), "id: b\ntitle: Wiki B\nnavigation:\n  - beta\n");
      await writeFile(join(dirB, "beta.md"), "# Beta\n");

      const loaderA = topikWikiLoader({ dir: dirA, name: "shared-wiki-name" });
      const loaderB = topikWikiLoader({ dir: dirB, name: "shared-wiki-name" });
      const ctxA = createMockContext();
      const ctxB = createMockContext();

      await loaderA.load(ctxA);
      await loaderB.load(ctxB);

      expect(await loaderA.getNavigation()).toEqual([
        expect.objectContaining({ type: "page", slug: "alpha", sourcePath: "alpha" }),
      ]);
      expect(await loaderB.getNavigation()).toEqual([
        expect.objectContaining({ type: "page", slug: "beta", sourcePath: "beta" }),
      ]);

      await writeFile(join(dirA, "alpha.md"), "{% unknown /%}\n");
      await expect(loaderA.load(ctxA)).rejects.toBeDefined();
      await expect(loaderA.getNavigation()).rejects.toBeDefined();
      expect(await loaderB.getNavigation()).toEqual([
        expect.objectContaining({ type: "page", slug: "beta", sourcePath: "beta" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

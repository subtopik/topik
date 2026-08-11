import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { LoaderContext } from "astro/loaders";
import { topikGuidesLoader } from "./guides";

const fixturesDir = join(import.meta.dirname, "__fixtures__/guides");
const fixtureOptions = { dir: fixturesDir, sourceNamespace: "astro-guide-fixtures" } as const;
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

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

describe("topikGuidesLoader", () => {
  test("returns a loader with the correct name", () => {
    const loader = topikGuidesLoader(fixtureOptions);
    expect(loader.name).toBe("topik-guides");
  });

  test("rejects an invalid Asset source namespace at configuration time", () => {
    expect(() => topikGuidesLoader({ dir: fixturesDir, sourceNamespace: "" })).toThrow(
      /source namespace/u,
    );
  });

  test("loads guides from a directory", async () => {
    const loader = topikGuidesLoader(fixtureOptions);
    const ctx = createMockContext();
    await loader.load(ctx);

    expect(ctx.entries.size).toBe(2);
  });

  test("populates guide entries with correct data", async () => {
    const loader = topikGuidesLoader(fixtureOptions);
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("guides-getting-started");
    expect(entry).toBeDefined();
    expect(entry!.data.title).toBe("Getting Started");
    expect(entry!.data.slug).toBe("getting-started");
    expect(entry!.data.description).toBe("Learn how to get started.");
    expect(entry!.data.authors).toEqual(["lukasnehrke"]);
    expect(entry!.data.tags).toEqual(["tutorial", "quickstart"]);
  });

  test("includes body content", async () => {
    const loader = topikGuidesLoader(fixtureOptions);
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("guides-getting-started");
    expect(entry!.body).toContain("# Getting Started");
  });

  test("merges collection tags with frontmatter tags", async () => {
    const loader = topikGuidesLoader(fixtureOptions);
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("guides-writing-markdown");
    expect(entry!.data.tags).toEqual(["tutorial", "markdown"]);
  });

  test("defaults authors to empty array when not specified", async () => {
    const loader = topikGuidesLoader(fixtureOptions);
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("guides-writing-markdown");
    expect(entry!.data.authors).toEqual([]);
  });

  test("retains compiler-emitted Asset descriptors and resolves rewritten Guide content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "topik-astro-guides-assets-"));
    try {
      await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
      await writeFile(join(dir, "hero.png"), PNG_BYTES);
      await writeFile(join(dir, "manual.pdf"), "%PDF-1.7\nmanual\n");
      await writeFile(
        join(dir, "intro.md"),
        "# Intro\n\n![Hero](hero.png)\n\n[Manual](manual.pdf)\n",
      );
      const loader = topikGuidesLoader({ dir, sourceNamespace: "astro-guides-assets" });
      const context = createMockContext();

      await loader.load(context);

      const body = context.entries.get("guides-intro")?.body ?? "";
      const assets = loader.getAssets();
      expect(assets).toHaveLength(2);
      expect(body.match(/asset:auto-v1-[a-z2-7]{52}/gu)).toHaveLength(2);
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

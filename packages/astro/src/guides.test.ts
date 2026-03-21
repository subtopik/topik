import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { topikGuidesLoader } from "./guides";

const fixturesDir = join(import.meta.dirname, "__fixtures__/guides");

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
  };
}

describe("topikGuidesLoader", () => {
  test("returns a loader with the correct name", () => {
    const loader = topikGuidesLoader({ dir: fixturesDir });
    expect(loader.name).toBe("topik-guides");
  });

  test("loads guides from a directory", async () => {
    const loader = topikGuidesLoader({ dir: fixturesDir });
    const ctx = createMockContext();
    await loader.load(ctx);

    expect(ctx.entries.size).toBe(2);
  });

  test("populates guide entries with correct data", async () => {
    const loader = topikGuidesLoader({ dir: fixturesDir });
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
    const loader = topikGuidesLoader({ dir: fixturesDir });
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("guides-getting-started");
    expect(entry!.body).toContain("# Getting Started");
  });

  test("merges collection tags with frontmatter tags", async () => {
    const loader = topikGuidesLoader({ dir: fixturesDir });
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("guides-writing-markdown");
    expect(entry!.data.tags).toEqual(["tutorial", "markdown"]);
  });

  test("defaults authors to empty array when not specified", async () => {
    const loader = topikGuidesLoader({ dir: fixturesDir });
    const ctx = createMockContext();
    await loader.load(ctx);

    const entry = ctx.entries.get("guides-writing-markdown");
    expect(entry!.data.authors).toEqual([]);
  });
});

import { describe, expect, test } from "vite-plus/test";
import {
  analyzeTopikContent,
  createTopikContentCache,
  extractTopikAssetOccurrences,
  pruneTopikContentCache,
  parseTopikContent,
  rewriteTopikAssetOccurrences,
  rewriteTopikNavigationReferences,
  validateTopikContent,
} from "./index";
import { assertDataLimits } from "./limits";

const source = "# Intro\n\n![Logo](logo.png)\n\nSee [next](next.md) and [intro](#intro).\n";

describe("TopikContentCache", () => {
  test("shares one parse between every call given the same cache", () => {
    const cache = createTopikContentCache();
    expect(validateTopikContent(source, { cache }).valid).toBe(true);
    const shared = parseTopikContent(source, { cache });
    expect(analyzeTopikContent(source, { cache }).headings).toMatchObject([{ id: "intro" }]);
    expect(extractTopikAssetOccurrences(source, { cache })).toHaveLength(1);
    expect(parseTopikContent(source, { cache })).toBe(shared);
  });

  test("returns what an uncached call returns", () => {
    const cache = createTopikContentCache();
    validateTopikContent(source, { cache });
    expect(analyzeTopikContent(source, { cache })).toEqual(analyzeTopikContent(source));
    expect(extractTopikAssetOccurrences(source, { cache })).toEqual(
      extractTopikAssetOccurrences(source),
    );
  });

  test("shares a frozen tree, and parses afresh without a cache", () => {
    const cache = createTopikContentCache();
    const shared = parseTopikContent(source, { cache });
    expect(parseTopikContent(source, { cache })).toBe(shared);
    expect(Object.isFrozen(shared.children[0])).toBe(true);
    const own = parseTopikContent(source);
    expect(own).not.toBe(shared);
    expect(Object.isFrozen(own)).toBe(false);
  });

  test("rewrites a copy and leaves the shared tree for later calls", () => {
    const cache = createTopikContentCache();
    const before = structuredClone(parseTopikContent(source, { cache }));
    expect(rewriteTopikNavigationReferences(source, () => "/next", { cache })).toMatchObject({
      ok: true,
      content: expect.stringContaining("[next](/next)"),
    });
    expect(
      rewriteTopikAssetOccurrences(
        source,
        (occurrence) => (occurrence.slot === "image.src" ? "images/other.png" : undefined),
        { cache, includeGenericLinkCandidates: true },
      ),
    ).toMatchObject({ ok: true, content: expect.stringContaining("![Logo](images/other.png)") });
    expect(parseTopikContent(source, { cache })).toEqual(before);
    expect(extractTopikAssetOccurrences(source, { cache })).toEqual(
      extractTopikAssetOccurrences(source),
    );
  });

  test("does not share documents parsed with custom components", () => {
    const cache = createTopikContentCache();
    const config = {
      components: {
        panel: { kind: "block", render: "Panel", attributes: {}, children: "blocks" },
      },
    } as const;
    const custom = "{% panel %}\nText\n{% /panel %}\n";
    const first = parseTopikContent(custom, { cache, config });
    expect(parseTopikContent(custom, { cache, config })).not.toBe(first);
    expect(Object.isFrozen(first)).toBe(false);
  });

  test("keeps what was read since the previous prune and drops the rest", () => {
    const cache = createTopikContentCache();
    const kept = parseTopikContent("# Kept\n", { cache });
    const dropped = parseTopikContent("# Dropped\n", { cache });
    pruneTopikContentCache(cache);
    expect(parseTopikContent("# Kept\n", { cache })).toBe(kept);
    pruneTopikContentCache(cache);
    expect(parseTopikContent("# Kept\n", { cache })).toBe(kept);
    expect(parseTopikContent("# Dropped\n", { cache })).not.toBe(dropped);
  });

  test("skips the data-limit check only for a shared tree that passed it", () => {
    const cache = createTopikContentCache();
    const shared = parseTopikContent(source, { cache });
    expect(() => assertDataLimits(shared, { plain: true })).not.toThrow();
    // A copy is not recorded, so its changes are checked again.
    const copy = structuredClone(shared) as unknown as { children: unknown[] };
    copy.children.push(() => undefined);
    expect(() => assertDataLimits(copy, { plain: true })).toThrow();
  });
});

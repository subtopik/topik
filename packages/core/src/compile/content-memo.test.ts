import { describe, expect, test } from "vite-plus/test";
import type { TopikNavigationReference } from "@topik/content";
import { createContentMemo } from "./content-memo";

const keyOf = (reference: TopikNavigationReference) => `${reference.kind}:${reference.href}`;
const source = "# Intro\n\nSee [next](next.md), [other](other.md) and [next again](next.md).\n";

describe("ContentMemo", () => {
  test("rewrites navigation and lists the replaced references in document order", () => {
    const memo = createContentMemo();
    const { result, replaced } = memo.rewriteNavigation(
      source,
      { file: "intro.md" },
      new Map([["link:next.md", "/next"]]),
      keyOf,
    );
    expect(result).toMatchObject({
      ok: true,
      content: "# Intro\n\nSee [next](/next), [other](other.md) and [next again](/next).\n",
    });
    expect(replaced.map(({ href, position }) => [href, position])).toEqual([
      ["next.md", "1/1"],
      ["next.md", "1/5"],
    ]);
  });

  test("reuses a rewrite only for the same file and replacements", () => {
    const memo = createContentMemo();
    const rewrite = (file: string, replacements: [string, string][]) =>
      memo.rewriteNavigation(source, { file }, new Map(replacements), keyOf);
    const first = rewrite("intro.md", [
      ["link:next.md", "/next"],
      ["link:other.md", "/other"],
    ]);
    expect(
      rewrite("intro.md", [
        ["link:other.md", "/other"],
        ["link:next.md", "/next"],
      ]),
    ).toBe(first);
    expect(rewrite("intro.md", [["link:next.md", "/next"]])).not.toBe(first);
    expect(
      rewrite("guide.md", [
        ["link:next.md", "/next"],
        ["link:other.md", "/other"],
      ]),
    ).not.toBe(first);
  });

  test("keeps results across one prune when they are read again, and freezes them", () => {
    const memo = createContentMemo();
    const validation = memo.validate(source, "intro.md");
    const analysis = memo.analyze("# Unused\n", "unused.md");
    expect(Object.isFrozen(validation.errors)).toBe(true);
    memo.prune();
    expect(memo.validate(source, "intro.md")).toBe(validation);
    memo.prune();
    expect(memo.validate(source, "intro.md")).toBe(validation);
    expect(memo.analyze("# Unused\n", "unused.md")).not.toBe(analysis);
  });
});

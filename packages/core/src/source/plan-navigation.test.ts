import { expect, test } from "vite-plus/test";
import { alignNavigation } from "./plan-navigation";

const names = (count: number) => Array.from({ length: count }, (_, index) => `page-${index}`);

test("an unchanged or locally edited long list aligns without comparing every pair", () => {
  const list = names(10_000);
  const unchanged = alignNavigation(list, [...list])!;
  expect(unchanged.anchors).toHaveLength(10_000);
  expect([unchanged.pairs, unchanged.removals, unchanged.additions]).toEqual([[], [], []]);

  const appended = alignNavigation(list, [...list, "new"])!;
  expect(appended.additions).toEqual([10_000]);
  expect(appended.removals).toEqual([]);

  const removed = alignNavigation(
    list,
    list.filter((name) => name !== "page-5000"),
  )!;
  expect(removed.removals).toEqual([5000]);
  expect(removed.additions).toEqual([]);
});

test("small lists keep their in-place and rewrite decisions", () => {
  expect(alignNavigation(["a", "b"], ["b", "a"])).toMatchObject({
    anchors: [[1, 0]],
    removals: [0],
    additions: [1],
  });
  expect(alignNavigation(["a", "b", "c"], ["a", "x", "c"])).toMatchObject({
    anchors: [
      [0, 0],
      [2, 2],
    ],
    pairs: [[1, 1]],
  });
  // An addition before a kept item cannot be written in place.
  expect(alignNavigation(["a", "b"], ["x", "a", "b"])).toBeUndefined();
});

test("long lists of distinct items keep in-place moves without a comparison table", () => {
  // Moving the first entry to the end stays a removal and an append.
  const modules = names(1_000);
  expect(alignNavigation(modules, [...modules.slice(1), modules[0]])).toMatchObject({
    removals: [0],
    additions: [999],
  });
  const pages = names(10_000);
  const moved = alignNavigation(pages, [...pages.slice(1), pages[0]])!;
  expect([moved.removals, moved.additions, moved.anchors.length]).toEqual([[0], [9_999], 9_999]);
  // A reversal keeps the last entry and appends the others after it, in their new order.
  const reversed = alignNavigation(pages, [...pages].reverse())!;
  expect(reversed.anchors).toEqual([[9_999, 0]]);
  expect([reversed.removals.length, reversed.additions.length]).toEqual([9_999, 9_999]);
});

test("a long list that repeats items and changes throughout is rewritten", () => {
  const list = [...names(1_500), "page-0"];
  expect(alignNavigation(list, [...list].reverse())).toBeUndefined();
});

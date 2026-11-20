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

test("a long list reordered throughout is rewritten instead of compared pair by pair", () => {
  const list = names(2_000);
  expect(alignNavigation(list, [...list].reverse())).toBeUndefined();
});

import { posix } from "node:path";
import type { Wiki, WikiNavNode } from "@topik/schema/wiki/v1";
import type { WikiNavNode as SourceWikiNavNode } from "../config/wiki";
import { serializeTopikJson } from "../assets/json";
import { joinWikiPath } from "../wiki-navigation";
import { failSourcePlan as block } from "./diagnostics";

export function sourceNavigation(
  nodes: readonly WikiNavNode[],
  wiki: Wiki,
  paths: ReadonlyMap<string, string>,
  directory: string,
  prefix = "",
): SourceWikiNavNode[] {
  return nodes.map((node) => {
    if (node.type === "page") {
      const path = paths.get(`WikiPage/${node.page}`);
      if (!path || (directory && !path.startsWith(`${directory}/`)))
        block(
          "source-mapping-missing",
          "Navigation must reference a page owned by its declared source.",
          `Wiki/${wiki.name}`,
        );
      const source = posix.relative(directory || ".", path).replace(/\.mdx?$/i, "");
      const localSlug = node.slug === "" ? "index" : node.slug;
      return {
        type: "page",
        slug: localSlug,
        ...(source !== joinWikiPath(prefix, localSlug) ? { source } : {}),
        ...(node.icon !== undefined ? { icon: node.icon } : {}),
        ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
      };
    }
    return "children" in node
      ? {
          ...node,
          children: sourceNavigation(
            node.children,
            wiki,
            paths,
            directory,
            joinWikiPath(prefix, "slug" in node ? node.slug : undefined),
          ),
        }
      : node;
  });
}

export interface NavigationSequenceEdit {
  additions: unknown[];
  removals: string[];
}

/**
 * Align a changed navigation list with its source items. Unchanged items keep
 * their syntax; removed items are deleted in place and new items are appended.
 * Returns undefined when the change needs a new item before a retained one.
 */
/** Largest comparison table a list alignment builds, about 4 MB. */
const MAX_ALIGNMENT_CELLS = 1_000_000;

export function alignNavigation(
  previous: readonly unknown[],
  desired: readonly unknown[],
):
  | {
      /** Identical items, by previous and desired position. */
      anchors: Array<[number, number]>;
      /** Items in equal-sized gaps, edited in place. */
      pairs: Array<[number, number]>;
      removals: number[];
      additions: number[];
    }
  | undefined {
  const before = previous.map((item) => serializeTopikJson(item ?? null));
  const after = desired.map((item) => serializeTopikJson(item ?? null));
  // Identical leading and trailing items anchor themselves, so an unchanged list or a local
  // edit compares only the changed middle.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const rows = before.length - start - end;
  const columns = after.length - start - end;
  // A middle too large to compare is rewritten as one value, which is always faithful.
  if ((rows + 1) * (columns + 1) > MAX_ALIGNMENT_CELLS) return undefined;
  // Longest common subsequence of identical middle items anchors the retained entries.
  const table = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1));
  for (let i = rows - 1; i >= 0; i--)
    for (let j = columns - 1; j >= 0; j--)
      table[i][j] =
        before[start + i] === after[start + j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const anchors: Array<[number, number]> = [];
  for (let index = 0; index < start; index++) anchors.push([index, index]);
  for (let i = 0, j = 0; i < rows && j < columns;)
    if (before[start + i] === after[start + j]) anchors.push([start + i++, start + j++]);
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  for (let offset = end; offset > 0; offset--)
    anchors.push([before.length - offset, after.length - offset]);
  const pairs: Array<[number, number]> = [];
  const removals: number[] = [];
  const additions: number[] = [];
  let i = 0;
  let j = 0;
  for (const [anchorBefore, anchorAfter] of [
    ...anchors,
    [before.length, after.length] as [number, number],
  ]) {
    const removed = anchorBefore - i;
    const added = anchorAfter - j;
    const last = anchorBefore === before.length;
    if (removed === added || (last && added > removed)) {
      // Equal gaps are edits of the same entries; a longer final gap appends.
      for (let offset = 0; offset < removed; offset++) pairs.push([i + offset, j + offset]);
      for (let offset = removed; offset < added; offset++) additions.push(j + offset);
    } else if (added === 0) {
      for (let offset = 0; offset < removed; offset++) removals.push(i + offset);
    } else return undefined;
    i = anchorBefore + 1;
    j = anchorAfter + 1;
  }
  return { anchors, pairs, removals, additions };
}

export function collectNavigationEdits(
  updates: Record<string, unknown>,
  sequences: Map<string, NavigationSequenceEdit>,
  selector: string,
  raw: unknown,
  previous: unknown,
  desired: unknown,
): void {
  if (serializeTopikJson(previous ?? null) === serializeTopikJson(desired ?? null)) return;
  const alignment =
    Array.isArray(previous) &&
    Array.isArray(desired) &&
    Array.isArray(raw) &&
    raw.length === previous.length
      ? alignNavigation(previous, desired)
      : undefined;
  if (alignment && Array.isArray(previous) && Array.isArray(desired) && Array.isArray(raw)) {
    for (const [before, after] of alignment.pairs)
      collectNavigationEdits(
        updates,
        sequences,
        `${selector}/${before}`,
        raw[before],
        previous[before],
        desired[after],
      );
    if (alignment.removals.length || alignment.additions.length)
      sequences.set(selector, {
        additions: alignment.additions.map((index) => desired[index]),
        removals: alignment.removals.map((index) => `${selector}/${index}`),
      });
  } else if (
    raw &&
    previous &&
    desired &&
    typeof raw === "object" &&
    typeof previous === "object" &&
    typeof desired === "object" &&
    !Array.isArray(raw) &&
    !Array.isArray(previous) &&
    !Array.isArray(desired)
  ) {
    const before = previous as Record<string, unknown>;
    const after = desired as Record<string, unknown>;
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)]))
      collectNavigationEdits(
        updates,
        sequences,
        `${selector}/${encodeURIComponent(field)}`,
        (raw as Record<string, unknown>)[field],
        before[field],
        after[field],
      );
  } else updates[selector] = desired;
}

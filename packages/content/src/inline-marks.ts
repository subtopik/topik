import type { TreeNode } from "./model.js";
import { blockTypes } from "./node-grammar.js";

/**
 * Inline marks in priority order. A rich-text editor stores these as an
 * unordered set on each text run, so their Markdown nesting order carries no
 * meaning. The order breaks ties when several marks cover the same content:
 * emphasis outside strong writes bold italics as `_**a**_` rather than
 * `**_a_**`.
 */
const MARKS = ["emphasis", "strong", "delete"] as const;
const BITS: Record<string, number> = { emphasis: 1, strong: 2, delete: 4 };
// CommonMark mark delimiters beside a link bracket open or close only next to
// whitespace, punctuation, or another delimiter.
const WORD_START = /^[^\s\p{P}\p{S}]/u;
const WORD_END = /[^\s\p{P}\p{S}]$/u;
const PHRASING_PARENTS = new Set(["paragraph", "heading", "tableCell"]);

interface Item {
  node: TreeNode;
  /** Bit set of the marks that apply to this leaf or to all of this link's content. */
  marks: number;
  /** Flattened content of a link or link reference, which keeps its identity. */
  inner?: Item[];
}

/**
 * Return the canonical spelling of an admitted tree's inline marks without
 * mutating it. Every phrasing container (paragraph, heading, table cell, and
 * inline-content component) is canonicalized on its own; component children
 * and block structure are never crossed.
 *
 * Within a container, each leaf (text, inline code, image, break, variable,
 * inline component) carries the set of `strong`, `emphasis`, and `delete`
 * marks above it; repeated marks of one kind collapse. A link carries a mark
 * when all of its content does, and stays one node. Adjacent text with the
 * same marks merges. The canonical tree is rebuilt from that sequence:
 *
 * 1. At each position, among the marks the item carries that no ancestor
 *    already applies, open the mark whose run of consecutive items reaches
 *    farthest, preferring `emphasis`, then `strong`, then `delete` on ties.
 *    That mark node covers the whole run, clipped to its parent.
 * 2. Marks that cover exactly one link and nothing else are written outside
 *    it (`**[a](u)**`), unless an unmarked letter, digit, or other non-space,
 *    non-punctuation character of the neighboring text would then touch a
 *    delimiter (`[**a**](u)s`): Markdown cannot close or open a mark there.
 *    They are then written inside the link, provided its content neither
 *    starts nor ends with whitespace or a hard break.
 *
 * The result never nests a mark inside its own kind, never nests deeper than
 * the input, and depends only on the sequence of leaves and links and their
 * mark sets, so equivalent spellings produce identical trees.
 */
export function canonicalizeInlineMarks<T extends object>(root: T): T {
  return canonical(root as unknown as TreeNode) as unknown as T;
}

function canonical(node: TreeNode): TreeNode {
  const children = node.children;
  if (!children) return node;
  return {
    ...node,
    children: isPhrasingContainer(node) ? phrasing(children) : children.map(canonical),
  };
}

function isPhrasingContainer(node: TreeNode): boolean {
  if (PHRASING_PARENTS.has(node.type)) return true;
  // Inline components contain phrasing; block components contain blocks or
  // other components, which are opaque leaves here and therefore unchanged.
  return (
    node.type === "topikComponent" && !node.children!.some((child) => blockTypes.has(child.type))
  );
}

function phrasing(children: TreeNode[]): TreeNode[] {
  const items: Item[] = [];
  flatten(children, 0, items);
  return emit(items, runEnds(items), 0, items.length, 0);
}

function flatten(children: readonly TreeNode[], marks: number, items: Item[]): void {
  for (const child of children) {
    const bit = BITS[child.type];
    if (bit) {
      flatten(child.children ?? [], marks | bit, items);
      continue;
    }
    if (child.type === "link" || child.type === "linkReference") {
      const inner: Item[] = [];
      flatten(child.children ?? [], marks, inner);
      const shared = inner.length ? inner.reduce((set, item) => set & item.marks, 7) : marks;
      items.push({ node: child, marks: shared, inner });
      continue;
    }
    const previous = items.at(-1);
    if (
      child.type === "text" &&
      previous?.node.type === "text" &&
      previous.marks === marks &&
      typeof child.value === "string"
    ) {
      previous.node = { type: "text", value: String(previous.node.value) + child.value };
      continue;
    }
    items.push({ node: canonical(child), marks });
  }
}

/** For each mark, the last index of the run of consecutive items carrying it. */
function runEnds(items: readonly Item[]): Int32Array[] {
  return MARKS.map((mark) => {
    const bit = BITS[mark];
    const ends = new Int32Array(items.length);
    for (let index = items.length - 1; index >= 0; index--)
      ends[index] =
        items[index].marks & bit
          ? index + 1 < items.length && items[index + 1].marks & bit
            ? ends[index + 1]
            : index
          : index - 1;
    return ends;
  });
}

function emit(
  items: readonly Item[],
  ends: readonly Int32Array[],
  start: number,
  end: number,
  applied: number,
): TreeNode[] {
  const output: TreeNode[] = [];
  let index = start;
  while (index < end) {
    const item = items[index];
    const remaining = item.marks & ~applied;
    if (!remaining) {
      output.push(leaf(item, applied));
      index++;
      continue;
    }
    let best = 0;
    let last = -1;
    for (let mark = 0; mark < MARKS.length; mark++) {
      if (!(remaining & BITS[MARKS[mark]])) continue;
      const reach = Math.min(ends[mark][index], end - 1);
      if (reach > last) {
        best = mark;
        last = reach;
      }
    }
    if (
      last === index &&
      item.inner &&
      touchesWord(items, index, start, end, applied) &&
      marksFitInside(item.inner)
    ) {
      output.push(leaf(item, applied));
      index++;
      continue;
    }
    output.push({
      type: MARKS[best],
      children: emit(items, ends, index, last + 1, applied | BITS[MARKS[best]]),
    });
    index = last + 1;
  }
  return output;
}

function leaf(item: Item, applied: number): TreeNode {
  if (!item.inner) return item.node;
  return {
    ...item.node,
    children: emit(item.inner, runEnds(item.inner), 0, item.inner.length, applied),
  };
}

/** Whether unmarked neighboring text would touch delimiters written around this item. */
function touchesWord(
  items: readonly Item[],
  index: number,
  start: number,
  end: number,
  applied: number,
): boolean {
  const before = index > start ? items[index - 1] : undefined;
  const after = index + 1 < end ? items[index + 1] : undefined;
  return (
    (before?.node.type === "text" &&
      before.marks === applied &&
      WORD_END.test(before.node.value ?? "")) ||
    (after?.node.type === "text" &&
      after.marks === applied &&
      WORD_START.test(after.node.value ?? ""))
  );
}

/** Whether delimiters placed just inside a link's brackets remain valid Markdown marks. */
function marksFitInside(inner: readonly Item[]): boolean {
  const first = inner[0]?.node;
  const last = inner.at(-1)?.node;
  if (!first || !last || first.type === "break" || last.type === "break") return false;
  return !(
    (first.type === "text" && /^\s/u.test(first.value ?? "")) ||
    (last.type === "text" && /\s$/u.test(last.value ?? ""))
  );
}

/**
 * Property tests over generated documents (see `testing/grammar.ts`).
 *
 * CI runs a fixed seed. `vp run fuzz` explores: a random seed (or TOPIK_FUZZ_SEED), twenty
 * times the runs (or TOPIK_FUZZ_RUNS) and a wall-clock check of the parser budget. fast-check
 * reports a failure's seed and path and shrinks it; add the shrunk input to a regular test.
 */
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  compileTopikContent,
  components,
  formatTopikContent,
  parseDocument,
  validateTopikContent,
} from "./index.js";
import { CONTENT_LIMITS } from "./limits.js";
import type { TreeNode } from "./model.js";
import { walkContent } from "./traversal.js";
import { budgetUnit, source, VARIABLES } from "./testing/grammar.js";

const EXPLORE = process.env.TOPIK_FUZZ === "1";
const SEED = EXPLORE
  ? Number(process.env.TOPIK_FUZZ_SEED) || Math.floor(Math.random() * 2 ** 31)
  : 20_261_121;
if (EXPLORE) console.info(`fuzz seed ${SEED}`);
const runs = (ci: number) => (EXPLORE ? Number(process.env.TOPIK_FUZZ_RUNS) || ci * 20 : ci);
const parameters = (ci: number): fc.Parameters<unknown> => ({ seed: SEED, numRuns: runs(ci) });
const timeout = (ci: number) => (EXPLORE ? 0 : ci);

const config = { variables: VARIABLES };
const MARKS = new Set(["em", "strong", "s"]);
const LINK = "TopikLink";
type Rendered = { name?: string; children?: unknown[] };

/**
 * Compare reader trees as the package compares documents: inline marks are a set on each run,
 * so `**a **b****` and `**a b**`, or `~~*a*~~` and `*~~a~~*`, render the same content. Each
 * run lists its marks, including those of marks around an enclosing link, and equal
 * neighbours merge. Marks distribute over a link: `[*a*](/p)` and `*[a](/p)*` render the same,
 * and the formatter writes a mark that covers a whole link outside it. So a link's runs carry
 * the marks around it, and the link itself carries none.
 */
function content(value: unknown, inherited: readonly string[] = []): unknown {
  const node = value as Rendered | null;
  if (!node || typeof node !== "object" || !node.children) return value;
  const result: { marks: string; value: unknown }[] = [];
  const flatten = (children: unknown[], marks: readonly string[]) => {
    for (const child of children) {
      const mark = (child as Rendered | null)?.name;
      if (mark && MARKS.has(mark)) {
        flatten((child as Rendered).children ?? [], [...new Set([...marks, mark])].sort());
        continue;
      }
      const value = content(child, marks);
      const previous = result.at(-1);
      if (
        typeof value === "string" &&
        typeof previous?.value === "string" &&
        previous.marks === marks.join()
      )
        previous.value += value;
      else
        result.push({
          marks: (child as Rendered | null)?.name === LINK ? "" : marks.join(),
          value,
        });
    }
  };
  flatten(node.children, inherited);
  return { ...node, children: result };
}

const tree = (text: string) => {
  const result = compileTopikContent(text, { config });
  return result.ok ? content(JSON.parse(JSON.stringify(result.tree))) : result.diagnostics;
};

describe("round trips", () => {
  test(
    "compilable documents format idempotently to the same content",
    () => {
      fc.assert(
        fc.property(source, (text) => {
          if (!compileTopikContent(text, { config }).ok) return;
          const formatted = formatTopikContent(text, { config });
          expect(formatted.ok ? [] : formatted.diagnostics).toEqual([]);
          if (!formatted.ok) return;
          const again = formatTopikContent(formatted.formatted, { config });
          expect(again.ok ? again.formatted : again.diagnostics).toEqual(formatted.formatted);
          expect(tree(formatted.formatted)).toEqual(tree(text));
        }),
        parameters(150),
      );
    },
    timeout(60_000),
  );

  test(
    "valid documents are formattable without configuration",
    () => {
      fc.assert(
        fc.property(source, (text) => {
          if (!validateTopikContent(text).ok) return;
          const formatted = formatTopikContent(text);
          expect(formatted.ok ? [] : formatted.diagnostics).toEqual([]);
        }),
        parameters(150),
      );
    },
    timeout(60_000),
  );

  test("the generator covers every registered component in valid documents", () => {
    const seen = new Set<string>();
    let valid = 0;
    const samples = fc.sample(source, { seed: SEED, numRuns: 300 });
    for (const text of samples) {
      const parsed = parseDocument(text);
      if (!parsed.ok || !compileTopikContent(text, { config }).ok) continue;
      valid++;
      walkContent(parsed.document as unknown as TreeNode, (node) => {
        const { type, name } = node as TreeNode & { name?: string };
        if (type === "topikComponent" && name) seen.add(name);
      });
    }
    // Most generated documents must be valid, or the round trips above test little.
    expect(valid / samples.length).toBeGreaterThan(0.6);
    expect(Object.keys(components).filter((name) => !seen.has(name))).toEqual([]);
  });
});

/**
 * Elements micromark and the pipeline copy or shift while validating: what `Array#slice`
 * returns and what `Array#splice` inserts or moves. micromark copies its event list this way
 * (an `EditMap` consume, a `splice` of container exits), so a shape whose cost grows with the
 * square of the document shows here, deterministically, whatever the machine's speed.
 */
function copiedElements(text: string): { copied: number; ok: boolean } {
  const { slice, splice } = Array.prototype;
  let copied = 0;
  Array.prototype.slice = function (this: unknown[], ...args: [number?, number?]) {
    const result = slice.apply(this, args);
    copied += result.length;
    return result;
  } as typeof slice;
  Array.prototype.splice = function (this: unknown[], ...args: [number, number?, ...unknown[]]) {
    const [start, remove, ...items] = args;
    const length = this.length;
    const from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
    const removed =
      args.length < 2 ? length - from : Math.max(0, Math.min(remove ?? 0, length - from));
    copied += items.length + (removed === items.length ? 0 : length - from - removed);
    return splice.apply(this, args as [number, number, ...unknown[]]);
  } as typeof splice;
  try {
    const ok = validateTopikContent(text).ok;
    return { copied, ok };
  } finally {
    Array.prototype.slice = slice;
    Array.prototype.splice = splice;
  }
}

/** A repeated unit reaches this size; past it, quadratic work exceeds the budget many times. */
const AMPLIFIED_BYTES = 32 * 1024;
/** Linear work per byte that ordinary documents copy, with room to spare. */
const COPIES_PER_BYTE = 100;
/** Work at a refusal overshoots the budget by the step that crossed it. */
const BUDGET = 1.25 * CONTENT_LIMITS.parserSteps;

describe("parser budget", () => {
  test("the copy counter sees micromark's event-list copies", () => {
    const linear = copiedElements("- a\n  - b\n".repeat(500)).copied;
    const quadratic = copiedElements("- a\n  - b\n".repeat(1_000)).copied;
    expect(linear).toBeGreaterThan(0);
    // Nested items close nested lists: micromark copies its whole event list for each.
    expect(quadratic / linear).toBeGreaterThan(3);
  });

  test(
    "repeated units cost at most the budget, accepted or refused",
    () => {
      fc.assert(
        fc.property(budgetUnit, (unit) => {
          const text = unit.repeat(Math.ceil(AMPLIFIED_BYTES / unit.length));
          const { copied } = copiedElements(text);
          expect(copied).toBeLessThanOrEqual(BUDGET + COPIES_PER_BYTE * text.length);
          if (EXPLORE) {
            // Walk-backs over events are plain loops the counter cannot see: time them.
            const started = performance.now();
            validateTopikContent(text);
            expect(performance.now() - started).toBeLessThan(5_000);
          }
        }),
        parameters(40),
      );
    },
    timeout(120_000),
  );
});

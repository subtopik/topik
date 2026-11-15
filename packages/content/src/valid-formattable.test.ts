import { describe, expect, test } from "vite-plus/test";
import { compileTopikContent, formatTopikContent } from "./index.js";

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "alpha",
  "beta",
  "x",
  "Two words",
  "1.",
  "-",
  "+",
  "#",
  "a_b",
  "é",
  "*",
  "!",
  "\\*",
  "\\[",
  "[",
  "]",
  "a < b",
  "&amp;",
  "&#42;",
  "_a_",
  "***",
  "\\|",
  ">",
  "1)",
  "{",
  "%",
  "``a ` b``",
];
const LINKS = [
  "[link](/page)",
  "[link](/page 'Title')",
  "[**bold** link](https://e.test/a)",
  "[ref][r]",
  "[r]",
  "<https://e.test/path>",
  "<https://e.test/a*b*c>",
  "<mailto:a@b.test>",
  "<a@b.test>",
  "[https://e.test](https://e.test)",
  "![alt](https://e.test/i.png)",
  '![alt *x*](https://e.test/i.png "Image")',
  "[](/empty)",
  "[a](</with space>)",
];
const TAGS = [
  "{% badge %}new{% /badge %}",
  '{% badge variant="info" %}b{% /badge %}',
  "{% $name %}",
  "{% $user.first %}",
  "{% u %}under{% /u %}",
];

/**
 * Random Topik Markdown built from the constructs the package supports: inline
 * marks, links and autolinks, inline tags and variables, headings, lists, task
 * lists, block quotes, code, tables, components, conditionals and nesting.
 */
function generate(next: () => number): string {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
  const chance = (probability: number) => next() < probability;
  function atom(depth: number): string {
    const choice = Math.floor(next() * (depth > 1 ? 4 : 9));
    switch (choice) {
      case 4:
        return `*${phrase(depth + 1)}*`;
      case 5:
        return `**${phrase(depth + 1)}**`;
      case 6:
        return `~~${phrase(depth + 1)}~~`;
      case 7:
        return pick(TAGS);
      case 8:
        return "`code`";
      case 3:
        return pick(LINKS);
      default:
        return pick(WORDS);
    }
  }
  function phrase(depth = 0): string {
    return Array.from({ length: 1 + Math.floor(next() * 3) }, () => atom(depth)).join(" ");
  }
  const indent = (lines: string[], first: string, rest: string) =>
    lines.map((line, index) => (index ? (line ? rest + line : "") : first + line));
  function list(depth: number): string[] {
    const ordered = chance(0.4);
    const task = !ordered && chance(0.4);
    const start = ordered ? pick([1, 2, 9]) : 0;
    const loose = chance(0.3);
    const lines: string[] = [];
    const count = 1 + Math.floor(next() * 3);
    for (let index = 0; index < count; index++) {
      if (index && loose) lines.push("");
      const marker = ordered ? `${start + index}. ` : task ? `- [${pick([" ", "x"])}] ` : "- ";
      const width = ordered ? marker.length : 2;
      const content = chance(0.1) ? [""] : chance(0.3) ? blocks(depth + 1) : [phrase()];
      lines.push(...indent(content, marker, " ".repeat(width)));
    }
    return lines;
  }
  function block(depth: number): string[] {
    const choice = depth > 2 ? Math.floor(next() * 3) : Math.floor(next() * 15);
    switch (choice) {
      case 1:
        return [
          `${"#".repeat(1 + Math.floor(next() * 4))} ${phrase()}${pick(["", "", " {% #stable %}"])}`,
        ];
      case 2:
        return [
          "```" + pick(["", "js", 'ts filename="a.ts"', "txt"]),
          ...pick([["x"], ["a", "", "b"]]),
          "```",
        ];
      case 3:
        return list(depth);
      case 4:
        return indent(blocks(depth + 1), "> ", "> ").map((line) => line || ">");
      case 5:
        return [
          "| Head | Other |",
          pick(["| --- | --- |", "| :-- | --: |", "| :-: | --- |"]),
          `| ${phrase()} | ${phrase()} |`,
          `| ${pick(WORDS)} | |`,
        ];
      case 6:
        return [
          pick(["{% callout %}", '{% callout variant="warning" title="Note" %}']),
          ...blocks(depth + 1),
          "{% /callout %}",
        ];
      case 7:
        return [
          "{% tabs %}",
          '{% tab title="One" %}',
          ...blocks(depth + 1),
          "{% /tab %}",
          '{% tab title="Two" %}',
          ...blocks(depth + 1),
          "{% /tab %}",
          "{% /tabs %}",
        ];
      case 8:
        return [
          "{% steps %}",
          '{% step title="First" %}',
          ...blocks(depth + 1),
          "{% /step %}",
          "{% /steps %}",
        ];
      case 9:
        return [
          "{% if $flag %}",
          ...blocks(depth + 1),
          ...(chance(0.5) ? ["{% else /%}", ...blocks(depth + 1)] : []),
          "{% /if %}",
        ];
      case 10:
        return [pick(["---", "[r]: /reference", '[r]: https://e.test "T"', "> quoted"])];
      case 11:
        return [`${phrase()}\\`, phrase()];
      case 12:
        // Adjacent lists, which the writer must keep apart.
        return [...list(depth), "", ...list(depth)];
      case 13:
        return [pick(["***", "* * *", "___"])];
      default:
        return [phrase()];
    }
  }
  function blocks(depth: number): string[] {
    const count = 1 + Math.floor(next() * (depth ? 2 : 4));
    const lines: string[] = [];
    for (let index = 0; index < count; index++) {
      if (index) lines.push("");
      lines.push(...block(depth));
    }
    return lines;
  }
  return ["[r]: /u", "", ...blocks(0), ""].join("\n");
}

const MARKS = new Set(["em", "strong", "s"]);
type Rendered = { name?: string; children?: unknown[] };

/**
 * Compare reader trees as the package compares documents: inline marks are a
 * set on each run, so `**a **b****` and `**a b**`, or `~~*a*~~` and `*~~a~~*`,
 * render the same content. Each run lists its marks, including those of marks
 * around an enclosing link; equal neighbours merge.
 */
function content(value: unknown, inherited: readonly string[] = []): unknown {
  const node = value as Rendered | null;
  if (!node || typeof node !== "object" || !node.children) return value;
  const runs: { marks: string; value: unknown }[] = [];
  const flatten = (children: unknown[], marks: readonly string[]) => {
    for (const child of children) {
      const mark = (child as Rendered | null)?.name;
      if (mark && MARKS.has(mark)) {
        flatten((child as Rendered).children ?? [], [...new Set([...marks, mark])].sort());
        continue;
      }
      const value = content(child, marks);
      const previous = runs.at(-1);
      if (
        typeof value === "string" &&
        typeof previous?.value === "string" &&
        previous.marks === marks.join()
      )
        previous.value += value;
      else runs.push({ marks: marks.join(), value });
    }
  };
  flatten(node.children, inherited);
  return { ...node, children: runs };
}

const options = {
  config: { variables: { name: "Ada", user: { first: "Ada" }, flag: true } },
};

// Fixed seeds keep CI deterministic; each seed checks a batch of documents.
const SEEDS = [1, 7, 42, 2_024, 20_261_115, 3_141_592, 27_182_818, 99_991];

describe("valid implies formattable", () => {
  test.each(SEEDS)(
    "seed %i: compilable documents format idempotently to the same content",
    (seed) => {
      const next = random(seed);
      let compiled = 0;
      for (let iteration = 0; iteration < 15; iteration++) {
        const source = generate(next);
        const before = compileTopikContent(source, options);
        if (!before.ok) continue;
        compiled++;
        const formatted = formatTopikContent(source, options);
        expect({ source, diagnostics: formatted.ok ? [] : formatted.diagnostics }).toEqual({
          source,
          diagnostics: [],
        });
        if (!formatted.ok) continue;
        const again = formatTopikContent(formatted.formatted, options);
        expect({ source, again: again.ok ? again.formatted : again.diagnostics }).toEqual({
          source,
          again: formatted.formatted,
        });
        const after = compileTopikContent(formatted.formatted, options);
        expect({
          source,
          tree: after.ok ? content(JSON.parse(JSON.stringify(after.tree))) : after.diagnostics,
        }).toEqual({
          source,
          tree: content(JSON.parse(JSON.stringify(before.tree))),
        });
      }
      // Keep the generator honest: most documents it builds must compile.
      expect(compiled).toBeGreaterThan(8);
    },
    30_000,
  );
});

import { describe, expect, test } from "vite-plus/test";
import type { PhrasingContent } from "mdast";
import {
  CONTENT_LIMITS,
  ContentLimitError,
  formatDocument,
  formatTopikContent,
  sameDocumentMeaning,
  writeDocument,
  type ContentDocument,
} from "./index.js";
import { canonicalizeInlineMarks } from "./inline-marks.js";
import { FORMAT_VERSION } from "./parser.js";
import { parse, withoutPositions } from "./test-helpers.js";
import { serializeDocument } from "./writer.js";
import type { TreeNode } from "./model.js";

function formatted(source: string): string {
  const result = formatTopikContent(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.formatted;
}

/** Format, then prove the output is a fixed point with the input's meaning. */
function expectCanonical(source: string): string {
  const output = formatted(source);
  expect(formatted(output)).toBe(output);
  expect(formatDocument(source)).toMatchObject({ ok: true, formatted: output });
  expect(writeDocument(parse(source))).toBe(output);
  const reparsed = parse(output);
  expect(sameDocumentMeaning(parse(source), reparsed)).toBe(true);
  // The canonical output re-parses to the canonical tree itself.
  expect(withoutPositions(canonicalizeInlineMarks(reparsed))).toEqual(withoutPositions(reparsed));
  return output;
}

describe("equivalent inline mark nestings", () => {
  test.each([
    [["**[a](https://e.com)**", "[**a**](https://e.com)"], "**[a](https://e.com)**\n"],
    [["*[a](https://e.com)*", "[*a*](https://e.com)"], "*[a](https://e.com)*\n"],
    [["***a***", "**_a_**", "_**a**_", "*__a__*"], "***a***\n"],
    [["~~**a**~~", "**~~a~~**"], "**~~a~~**\n"],
    [["*[**a**](u)*", "***[a](u)***", "[***a***](u)", "**[*a*](u)**"], "***[a](u)***\n"],
    [["[~~*a*~~](u)", "*~~[a](u)~~*", "~~[*a*](u)~~"], "*~~[a](u)~~*\n"],
    [["**a*b***_c_", "**a**_**b**c_"], "**a*b***_c_\n"],
    [["**[a](u)b**", "[**a**](u)**b**"], "**[a](u)b**\n"],
    [["**[a][r]**\n\n[r]: /x", "[**a**][r]\n\n[r]: /x"], "**[a][r]**\n\n[r]: /x\n"],
    [["**a**__b__", "__a__**b**"], "**ab**\n"],
    [["*first*_second_", "*firstsecond*"], "*firstsecond*\n"],
    [["***_a_****_a_***", "***aa***"], "***aa***\n"],
    [["*a *b* c*", "*a b c*"], "*a b c*\n"],
    [["# [**a**](u) b", "# **[a](u)** b"], "# **[a](u)** b\n"],
    [
      ["| [*a*](u) | **_b_** |\n| --- | --- |", "| *[a](u)* | ***b*** |\n| --- | --- |"],
      "| *[a](u)* | ***b*** |\n| -------- | ------- |\n",
    ],
    [["- [~~**a**~~](u) item", "- **~~[a](u)~~** item"], "- **~~[a](u)~~** item\n"],
    [
      ["{% badge %}[**a**](u){% /badge %}", "{% badge %}**[a](u)**{% /badge %}"],
      "{% badge %}**[a](u)**{% /badge %}\n",
    ],
    [
      [
        "{% callout %}\n_**a**_ [*b*](u)\n{% /callout %}",
        "{% callout %}\n***a*** *[b](u)*\n{% /callout %}",
      ],
      "{% callout %}\n***a*** *[b](u)*\n{% /callout %}\n",
    ],
  ])("%j share one canonical form", (sources, expected) => {
    for (const source of sources) expect(expectCanonical(source)).toBe(expected);
    for (const left of sources)
      for (const right of sources)
        expect(sameDocumentMeaning(parse(left), parse(right))).toBe(true);
  });

  test.each([
    ["**a** **b**", "**a b**"],
    ["[ab](u)", "[a](u)[b](u)"],
    ["[a](u)", "[a](u)[a](u)"],
    ["**[a](u)**", "[a](u)"],
    ["**[a](u) b**", "**[a](u)** b"],
    ["**a**", "**b**"],
    ["**a**b", "**ab**"],
    ["*a*", "**a**"],
    ["~~a~~", "*a*"],
    ["**{% badge %}a{% /badge %}**", "{% badge %}**a**{% /badge %}"],
    ["**a {% $x %} b**", "**a** {% $x %} **b**"],
    ["**a**\\\nb", "**a\\\nb**"],
  ])("keeps %j and %j distinct", (left, right) => {
    expect(sameDocumentMeaning(parse(left), parse(right))).toBe(false);
    expect(formatted(left)).not.toBe(formatted(right));
  });
});

describe("canonical writer output", () => {
  test.each([
    // Marks that cover one link go inside it when a delimiter would touch a word.
    ["[**a**](u)s", "[**a**](u)s\n"],
    ["x[**a**](u)y", "x[**a**](u)y\n"],
    ["x [**a**](u)y", "x [**a**](u)y\n"],
    ["(**[a](u)**)", "(**[a](u)**)\n"],
    ["**[a](u)**, b", "**[a](u)**, b\n"],
    ["*a* **[b](u)** c", "*a* **[b](u)** c\n"],
    ["**[a](u)[b](v)**", "**[a](u)[b](v)**\n"],
    ["**[ a ](u)**", "**[ a ](u)**\n"],
    ["**[a\\\n](u)**", "**[a\\\n](u)**\n"],
    ["**[](u)**", "**[](u)**\n"],
    // Intraword and punctuation-adjacent marks.
    ["a**b**c", "a**b**c\n"],
    ["a*b*c", "a*b*c\n"],
    ["**a**.", "**a**.\n"],
    ['**"a"**', '**"a"**\n'],
    ["**a**, *b*!", "**a**, *b*!\n"],
    ["***a*** b", "***a*** b\n"],
    ["***a** b*", "***a** b*\n"],
    ["**a *b***", "**a *b***\n"],
    ["**a *b* c**", "**a *b* c**\n"],
    ["*a **b** c*", "*a **b** c*\n"],
    ["**a**~~*b*~~", "**a**_~~b~~_\n"],
    // Other inline leaves carry the marks around them.
    ["**`a`**`b`", "**`a`**`b`\n"],
    ["_**`a`**_", "***`a`***\n"],
    ["**![i](p.png)**", "**![i](p.png)**\n"],
    ["[**![i](p.png)**](u)", "**[![i](p.png)](u)**\n"],
    ["**a\\\nb**", "**a\\\nb**\n"],
    ["**a\\\n*b***", "**a\\\n*b***\n"],
    ["**a {% $x %} b**", "**a {% $x %} b**\n"],
    ["_**{% $x %}**_", "***{% $x %}***\n"],
    ["**{% badge %}*a*{% /badge %}**", "**{% badge %}*a*{% /badge %}**\n"],
    ["## [**a**](u) {% #id %}", "## **[a](u)** {% #id %}\n"],
    ["- [x] **_done_**", "- [x] ***done***\n"],
    ["> [~~a~~](u)", "> ~~[a](u)~~\n"],
    [
      "{% if $x %}\n[**a**](u)\n{% else /%}\n_**b**_\n{% /if %}",
      "{% if $x %}\n**[a](u)**\n{% else /%}\n***b***\n{% /if %}\n",
    ],
  ])("formats %j as %j", (source, expected) => {
    expect(expectCanonical(source)).toBe(expected);
  });

  test("does not mutate caller-owned trees", () => {
    const document = parse("*[**a**](u) _**b**_*");
    const original = structuredClone(document);
    const canonical = canonicalizeInlineMarks(document);
    expect(canonical).not.toBe(document);
    expect(writeDocument(document)).toBe("***[a](u)** **b***\n");
    expect(sameDocumentMeaning(document, canonical)).toBe(true);
    expect(document).toEqual(original);
  });

  test("keeps marks outside a link when its content cannot take them", () => {
    const link = (value: string): PhrasingContent => ({
      type: "link",
      url: "u",
      title: null,
      children: [{ type: "text", value }],
    });
    const document = (value: string): ContentDocument => ({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "x" },
            { type: "strong", children: [link(value)] },
          ],
        },
      ],
    });
    for (const value of ["a", " a"]) {
      const written = writeDocument(document(value));
      expect(sameDocumentMeaning(parse(written), document(value))).toBe(true);
      expect(formatted(written)).toBe(written);
    }
    expect(writeDocument(document("a"))).toBe("x[**a**](u)\n");
  });

  test("measures the canonical tree against the source length limit", () => {
    // Strong around emphasis is written canonically as emphasis around strong.
    // Escaped asterisks double the output, so the limit is reached before the
    // tree's own string budget.
    const document = (stars: number, letters: number): ContentDocument => ({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "strong",
              children: [
                {
                  type: "emphasis",
                  children: [{ type: "text", value: "*".repeat(stars) + "a".repeat(letters) }],
                },
              ],
            },
          ],
        },
      ],
    });
    const sample = writeDocument(document(10, 0));
    expect(sample).toBe(`***${"\\*".repeat(10)}***\n`);
    const fixed = sample.length - 20;
    const letters = (CONTENT_LIMITS.sourceLength - fixed) % 2;
    const stars = (CONTENT_LIMITS.sourceLength - fixed - letters) / 2;
    const written = serializeDocument(document(stars, letters));
    expect(written).toHaveLength(CONTENT_LIMITS.sourceLength);
    expect(written.startsWith("***\\*")).toBe(true);
    expect(() => serializeDocument(document(stars, letters + 1))).toThrow(ContentLimitError);
  });
});

describe("randomized mark nestings", () => {
  type Mark = "strong" | "emphasis" | "delete";
  const MARKS: readonly Mark[] = ["strong", "emphasis", "delete"];
  interface Leaf {
    kind: "text";
    value: string;
    marks: Mark[];
  }
  interface LinkRun {
    kind: "link";
    url: string;
    children: Leaf[];
  }
  type Run = Leaf | LinkRun;

  function random(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generate(next: () => number): Run[] {
    const words = ["a", "b c", "d", "ef", " ", "g "];
    const leaf = (): Leaf => ({
      kind: "text",
      value: words[Math.floor(next() * words.length)],
      marks: MARKS.filter(() => next() < 0.5),
    });
    return Array.from({ length: 1 + Math.floor(next() * 6) }, (): Run => {
      if (next() >= 0.3) return leaf();
      return {
        kind: "link",
        url: `https://example.test/${Math.floor(next() * 2)}`,
        children: Array.from({ length: 1 + Math.floor(next() * 3) }, leaf),
      };
    });
  }

  /** Wrap each leaf separately, applying its marks in a random order. */
  function split(runs: readonly Run[], next: () => number, outside: boolean): PhrasingContent[] {
    const wrap = (child: PhrasingContent, marks: readonly Mark[]): PhrasingContent => {
      const order = [...marks].sort(() => next() - 0.5);
      return order.reduce<PhrasingContent>(
        (inner, mark) => ({ type: mark, children: [inner] }) as PhrasingContent,
        child,
      );
    };
    return runs.map((run) => {
      if (run.kind === "text") return wrap({ type: "text", value: run.value }, run.marks);
      const shared = outside
        ? MARKS.filter((mark) => run.children.every((child) => child.marks.includes(mark)))
        : [];
      const link: PhrasingContent = {
        type: "link",
        url: run.url,
        title: null,
        children: run.children.map((child) =>
          wrap(
            { type: "text", value: child.value },
            child.marks.filter((mark) => !shared.includes(mark)),
          ),
        ),
      };
      return wrap(link, shared);
    });
  }

  /** Group maximal runs greedily, using a random mark order at every level. */
  function grouped(runs: readonly Run[], next: () => number): PhrasingContent[] {
    type Item = { node: PhrasingContent; marks: Mark[] };
    const items: Item[] = runs.map((run) => {
      if (run.kind === "text")
        return { node: { type: "text", value: run.value }, marks: run.marks };
      const shared = MARKS.filter((mark) =>
        run.children.every((child) => child.marks.includes(mark)),
      );
      const inner = run.children.map((child) => ({
        node: { type: "text", value: child.value } as PhrasingContent,
        marks: child.marks.filter((mark) => !shared.includes(mark)),
      }));
      return {
        node: { type: "link", url: run.url, title: null, children: group(inner, []) },
        marks: shared,
      };
    });
    function group(list: readonly Item[], applied: readonly Mark[]): PhrasingContent[] {
      const output: PhrasingContent[] = [];
      for (let index = 0; index < list.length;) {
        const remaining = list[index].marks.filter((mark) => !applied.includes(mark));
        if (!remaining.length) {
          output.push(list[index++].node);
          continue;
        }
        const mark = remaining[Math.floor(next() * remaining.length)];
        let end = index;
        while (end + 1 < list.length && list[end + 1].marks.includes(mark)) end++;
        output.push({
          type: mark,
          children: group(list.slice(index, end + 1), [...applied, mark]),
        } as PhrasingContent);
        index = end + 1;
      }
      return output;
    }
    return group(items, []);
  }

  const markCount = (node: TreeNode): number =>
    (["strong", "emphasis", "delete"].includes(node.type) ? 1 : 0) +
    (node.children ?? []).reduce((sum, child) => sum + markCount(child), 0);

  test("formats every nesting of the same marked runs to one string", () => {
    const SAMPLES = 150;
    const next = random(0x7091c);
    let written = 0;
    for (let sample = 0; sample < SAMPLES; sample++) {
      const runs = generate(next);
      const documents: ContentDocument[] = [
        split(runs, next, false),
        split(runs, next, true),
        grouped(runs, next),
        grouped(runs, next),
      ].map((children) => ({ type: "root", children: [{ type: "paragraph", children }] }));
      const outputs = new Set<string>();
      for (const document of documents) {
        const canonical = canonicalizeInlineMarks(document);
        expect(withoutPositions(canonical)).toEqual(
          withoutPositions(canonicalizeInlineMarks(documents[0])),
        );
        expect(markCount(canonical as TreeNode)).toBeLessThanOrEqual(
          markCount(document as TreeNode),
        );
        expect(sameDocumentMeaning(document, documents[0])).toBe(true);
        let output: string;
        try {
          output = writeDocument(document);
        } catch {
          // A tree whose canonical form has no faithful Markdown spelling fails
          // for every nesting alike; the shared canonical tree proves that.
          continue;
        }
        outputs.add(output);
        expect(formatted(output)).toBe(output);
        expect(sameDocumentMeaning(parse(output), document)).toBe(true);
        // Each authored spelling that survives a round trip also formats canonically.
        let authored: string;
        try {
          authored = serializeDocument(document, undefined, FORMAT_VERSION, {
            preserveTreePositions: true,
          });
        } catch {
          continue;
        }
        const reparsed = formatTopikContent(authored);
        if (reparsed.ok && sameDocumentMeaning(parse(authored), document))
          expect(reparsed.formatted).toBe(output);
      }
      expect(outputs.size).toBeLessThanOrEqual(1);
      if (outputs.size) written++;
    }
    // Nearly every sample has a faithful canonical spelling.
    expect(written).toBeGreaterThan(SAMPLES * 0.9);
  }, 60_000);
});

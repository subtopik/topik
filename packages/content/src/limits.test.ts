import { describe, expect, test } from "vite-plus/test";
import {
  evaluateDocument,
  formatDocument,
  parseDocument,
  rewriteAssets,
  validateDocument,
  writeDocument,
  type ContentDocument,
  assignTopikHeadingIds,
  removeInvalidTopikAssetReferences,
  removeInvalidTopikNavigationReferences,
} from "./index.js";
import { parseExpression, writeExpression, type Expression } from "./expressions.js";
import { parseDocumentTree } from "./parser.js";

describe("content resource boundaries", () => {
  test.each([
    [400, 1],
    [160, 2],
  ])("bounds padding across %i-column sparse tables (%i tables)", (width, tables) => {
    const table = `|${" H |".repeat(width)}\n|${" - |".repeat(width)}\n${"|x|\n".repeat(width)}`;
    const source = Array.from({ length: tables }, () => table).join("\n");
    // Expansion must stop in the parser, before an oversized tree reaches
    // semantic validation or callers of the lower-level parse API.
    const result = parseDocumentTree(source);
    expect(result.source === source).toBe(true);
    expect(result.diagnostics).toMatchObject([
      { id: "topik-content-limit", message: expect.stringContaining("node limit") },
    ]);
    expect(result.document === undefined).toBe(true);
    expect(formatDocument(source)).toMatchObject({ ok: false, source });
  });

  test.each([
    ["source size", "x".repeat(1_000_001)],
    ["ordinary Markdown depth", "> ".repeat(2_000) + "Text."],
    [
      "component depth",
      "{% callout %}\n".repeat(2_000) + "Text.\n" + "{% /callout %}\n".repeat(2_000),
    ],
    [
      "expression depth",
      "{% if " + "not(".repeat(8_000) + "true" + ")".repeat(8_000) + " %}\nText.\n{% /if %}",
    ],
  ])("refuses excessive %s while preserving source", (_label, source) => {
    expect(parseDocument(source)).toMatchObject({
      ok: false,
      source,
      diagnostics: [{ id: "topik-content-limit" }],
    });
    expect(formatDocument(source)).toMatchObject({ ok: false, source });
  });

  test("rejects cyclic authoring trees at every cloning or recursive boundary", () => {
    const document: ContentDocument = { type: "root", children: [] };
    document.children.push(document as never);
    expect(validateDocument(document)).toMatchObject([{ id: "topik-content-limit" }]);
    for (const operation of [
      () => writeDocument(document),
      () => evaluateDocument(document, {}),
      () => rewriteAssets(document, (url) => url),
      () => assignTopikHeadingIds(document),
      () => removeInvalidTopikAssetReferences(document),
      () => removeInvalidTopikNavigationReferences(document),
    ])
      expect(operation).toThrow(/cycle/i);
  });

  test("bounds wide trees and metadata as well as nesting", () => {
    const wide = {
      type: "root",
      children: Array.from({ length: 50_001 }, () => ({ type: "thematicBreak" })),
    } as ContentDocument;
    expect(validateDocument(wide)).toMatchObject([{ id: "topik-content-limit" }]);
    const large = {
      type: "root",
      children: [],
      data: { extra: "x".repeat(1_000_001) },
    } as ContentDocument;
    expect(validateDocument(large)).toMatchObject([{ id: "topik-content-limit" }]);
    const deep = { type: "root", children: [], data: {} } as ContentDocument;
    let metadata = deep.data as Record<string, unknown>;
    for (let index = 0; index < 200; index++) {
      const child = {};
      metadata.child = child;
      metadata = child;
    }
    expect(validateDocument(deep)).toMatchObject([{ id: "topik-content-limit" }]);
  });

  test("bounds the accumulated interpolation output before concatenation", () => {
    const parsed = parseDocument("{% $value %} ".repeat(2_000));
    if (!parsed.ok) throw new Error("Expected a valid variable document");
    expect(() => evaluateDocument(parsed.document, { value: "x".repeat(1_000) })).toThrow(/limit/i);
  });

  test("accepts expression depth at the limit and refuses a wider expression tree", () => {
    const allowed = "not(".repeat(32) + "true" + ")".repeat(32);
    expect(writeExpression(parseExpression(allowed))).toBe(allowed);
    let broad = "true";
    for (let index = 0; index < 8; index++) broad = `and(${broad}, ${broad})`;
    expect(() => parseExpression(broad)).toThrow(/node limit/);
    expect(() => parseExpression("not(".repeat(33) + "true" + ")".repeat(33))).toThrow(
      /depth limit/,
    );
  });

  test.each([
    ["deep quotes", "> ".repeat(100_000) + "x"],
    [
      "deep lists",
      Array.from({ length: 500 }, (_, index) => "  ".repeat(index) + "- x").join("\n"),
    ],
    ["nested emphasis", "*_".repeat(100_000) + "x" + "_*".repeat(100_000)],
    [
      "unmatched code runs",
      Array.from({ length: 1_000 }, (_, index) => "`".repeat(index + 1) + "x").join(" "),
    ],
    [
      "unmatched code runs before a long paragraph",
      Array.from({ length: 85 }, (_, index) => "`".repeat(index + 1) + "x").join(" ") +
        " word".repeat(50_000),
    ],
    ["closing delimiters after many lines", "a\n".repeat(100_000) + "a_ ".repeat(1_000)],
    ["unmatched closing delimiters", "*a_ ".repeat(100_000)],
    ["dense delimiters across paragraphs", ("*a_ ".repeat(250) + "\n\n").repeat(950)],
    [
      "emphasis before a multi-line code span",
      "*a* ".repeat(300) + "`" + "a\n".repeat(100_000) + "`",
    ],
    ["unbalanced label ends", "[a ".repeat(4_000) + "] ".repeat(4_000)],
    // Each `]` makes the footnote tokenizer walk back to the latest label.
    ["label ends without a label start", "a] ".repeat(17_000)],
    ["label ends after escaped brackets", "\\[a]".repeat(17_000)],
    ["label ends after a balanced image start", "![" + "a]".repeat(16_000)],
    // Unmatched brackets split text into data runs merged by splicing.
    ["undefined full references", "[a][b]".repeat(16_666)],
    ["unclosed resources", "[a](".repeat(25_000)],
    ["nested images", "![".repeat(100_000) + "a" + "](b)".repeat(100_000)],
    ["deep inline tags", "{% badge %}".repeat(8_000) + "x" + "{% /badge %}".repeat(8_000)],
    // micromark copies the whole document event list each time container exits move back.
    ["lazy quote lines", "> a\nb\n".repeat(20_000)],
    ["block quotes ended by blank lines", "> a\n\n".repeat(30_000)],
    ["lists followed by paragraphs", "- a\n- b\n\nText\n\n".repeat(8_000)],
    ["sibling items with nested lists", "- a\n  - b\n".repeat(12_000)],
    ["sibling items with nested quotes", "- > a\n".repeat(20_000)],
    ["lazy lines after quoted headings", "> # h\nb\n".repeat(12_000)],
  ])("bounds parser work before resolving %s", (_label, source) => {
    const started = performance.now();
    const result = parseDocument(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected bounded parser refusal");
    expect(result.diagnostics[0].id).toBe("topik-content-limit");
    expect(result.source === source).toBe(true);
    // Controlled refusal is the security contract; leave scheduling headroom
    // when the surrounding suite or coverage instrumentation is running.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("does not count delimiter-shaped literal code as parser work", () => {
    for (const source of [
      "```\n" + "> *_[]!~ ".repeat(20_000) + "\n```",
      "`" + "*_[]!~ ".repeat(20_000) + "`",
      "\\*\\_".repeat(10_000),
    ]) {
      expect(parseDocument(source).ok).toBe(true);
    }
  });

  const sentence =
    "The **parser** turns `source` into a *tree*; see [the guide](https://example.com/guide), " +
    "~~old~~ notes, my_var and __init__ when _needed_! Use `code` and **bold _nested_ text**.";
  test.each([
    ["exclamations", "Hello! ".repeat(5_000)],
    ["intraword underscores", "my_var ".repeat(5_000)],
    ["code spans", "`a` ".repeat(4_200)],
    ["links", "[a](https://e.com) ".repeat(4_200)],
    ["bracketed text", "see [1] and [2], or (0, 1]. ".repeat(1_000)],
    ["bracketed paragraphs", "see [1] and [2], or (0, 1] and \\[x].\n\n".repeat(5_000)],
    ["references", "[r]: /u\n\n" + "[r] and [text][r] ![image][r] ".repeat(2_000)],
    ["images", "![a long alternative text for the image](i.png) ".repeat(2_000)],
    ["a dense paragraph", (sentence + " ").repeat(150)],
    ["a reference page", (sentence + "\n\n").repeat(600)],
    ["wrapped paragraphs", `${sentence}\n${sentence}\n${sentence}\n\n`.repeat(300)],
    [
      "a changelog",
      Array.from(
        { length: 20 },
        (_, version) =>
          `## v1.${version}\n\n` +
          Array.from(
            { length: 100 },
            (_, item) =>
              `- **Fix** issue \`${item}\` in [#${item}](https://e.com/${item}) ~~old~~ _x_\n`,
          ).join("") +
          "\n",
      ).join(""),
    ],
    [
      "a long tight list",
      Array.from(
        { length: 3_000 },
        (_, item) => `- **Fix** issue \`${item}\` in [#${item}](https://e.com/${item})\n`,
      ).join(""),
    ],
    ["quoted lines", "> A quoted line of ordinary prose.\n".repeat(5_000)],
    ["thematic breaks that look like list items", "* * *\n\n- - -\n\n".repeat(5_000)],
    [
      "nested lists",
      "- Item\n  - Detail\n  - Detail\n    > A note\n- Item\n\nText.\n\n".repeat(150),
    ],
    ["lazily wrapped quotes", `> ${sentence}\n${sentence}\n\n`.repeat(300)],
    ["lazily wrapped list items", `- ${sentence}\n${sentence}\n`.repeat(250)],
    [
      "a long table",
      "| a | b | c |\n| - | - | - |\n" +
        Array.from({ length: 2_000 }, (_, row) => `| **${row}** | \`x\` | [l](u) *e* |\n`).join(""),
    ],
  ])("admits ordinary prose at scale: %s", (_label, source) => {
    const result = parseDocument(source);
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
  });

  test("rejects excessive expression trees before recursive writing", () => {
    let expression: Expression = { type: "literal", value: true };
    for (let index = 0; index < 64; index++)
      expression = { type: "call", name: "not", args: [expression] };
    expect(() => writeExpression(expression)).toThrow(/limit/i);
    expect(() => parseExpression("not(".repeat(64) + "true" + ")".repeat(64))).toThrow(/limit/i);
    const cyclic: Expression = { type: "call", name: "not", args: [] };
    cyclic.args.push(cyclic);
    expect(() => writeExpression(cyclic)).toThrow(/cycle/i);
  });
});

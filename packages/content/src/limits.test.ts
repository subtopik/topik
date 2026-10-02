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
      // This still exceeds the weighted budget under coverage instrumentation;
      // the packed consumer checks the original 1,000-run performance case.
      Array.from({ length: 128 }, (_, index) => "`".repeat(index + 1) + "x").join(" "),
    ],
    ["deep inline tags", "{% badge %}".repeat(8_000) + "x" + "{% /badge %}".repeat(8_000)],
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

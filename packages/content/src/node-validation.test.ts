import { describe, expect, test } from "vite-plus/test";
import {
  evaluateDocument,
  validateDocument,
  writeDocument,
  type ContentDocument,
} from "./index.js";
import { parse, withoutPositions } from "./test-helpers.js";

const text = (value = "Text") => ({ type: "text", value });
const paragraph = (child: unknown) => ({ type: "paragraph", children: [child] });
const root = (child: unknown) => ({ type: "root", children: [child] }) as ContentDocument;

describe("external authoring-tree admission", () => {
  test("writes reference identity even when an editor leaves a stale display label", () => {
    const document = parse("[Read][old]\n\n[old]: https://example.com");
    const paragraph = document.children[0];
    const definition = document.children[1];
    if (
      paragraph.type !== "paragraph" ||
      paragraph.children[0].type !== "linkReference" ||
      definition.type !== "definition"
    )
      throw new Error("Expected reference fixtures");
    paragraph.children[0].identifier = "new";
    definition.identifier = "new";
    definition.label = "new";
    expect(validateDocument(document)).toEqual([]);
    const written = writeDocument(document);
    expect(written).toContain("[Read][new]");
    expect(evaluateDocument(parse(written), {}).children[0]).toMatchObject({
      children: [{ type: "link", url: "https://example.com" }],
    });
  });

  test.each(["a]b", "a[b", "a\\", "a".repeat(1000)])(
    "refuses unwritable reference identifiers",
    (identifier) => {
      const document = root({ type: "definition", identifier, url: "https://example.com" });
      expect(validateDocument(document)).toMatchObject([{ id: "topik-reference-label" }]);
      expect(() => writeDocument(document)).toThrow(/label/);
    },
  );

  test("reports malformed descendants before running a component's semantic rules", () => {
    const choice = { type: "topikComponent", name: "choice", children: [] };
    const document = root({
      type: "topikComponent",
      name: "quiz",
      props: {},
      children: [{ type: "topikComponent", name: "question", props: {}, children: [choice] }],
    });
    expect(validateDocument(document)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "attribute-type-invalid" })]),
    );
  });

  test("rejects shared node identities before rewriting can mutate another occurrence", () => {
    const child = paragraph(text());
    const document = { type: "root", children: [child, child] } as ContentDocument;
    expect(validateDocument(document)).toMatchObject([{ id: "topik-node-invalid" }]);
  });

  test.each([
    ["root inline content", text()],
    ["list without list items", { type: "list", children: [paragraph(text())] }],
    ["invalid heading depth", { type: "heading", depth: 42, children: [text()] }],
    ["empty strong", paragraph({ type: "strong", children: [] })],
    ["empty inline code", paragraph({ type: "inlineCode", value: "" })],
    ["multiline inline code", paragraph({ type: "inlineCode", value: "a\nb" })],
    ["NUL text", paragraph(text("a\0b"))],
    ["missing text value", paragraph({ type: "text" })],
    ["non-string URL", paragraph({ type: "link", url: 123, children: [text()] })],
    ["empty list", { type: "list", children: [] }],
    ["nested root", { type: "root", children: [] }],
    ["null child", null],
    ["missing component children", { type: "topikComponent", name: "callout", props: {} }],
    ["empty table", { type: "table", children: [] }],
    ["frontmatter closing fence in payload", { type: "yaml", value: "first\n--- \nsecond" }],
    ["trailing hard break", { type: "paragraph", children: [text(), { type: "break" }] }],
    [
      "nested links",
      paragraph({
        type: "link",
        url: "/outer",
        children: [{ type: "link", url: "/inner", children: [text()] }],
      }),
    ],
    ["malformed diagnostic position", { type: "paragraph", children: [], position: {} }],
    ["non-string variable path", paragraph({ type: "topikVariable", path: [true] })],
  ])("refuses %s before writing or evaluating", (_label, child) => {
    const document = root(child);
    expect(validateDocument(document).length).toBeGreaterThan(0);
    expect(() => writeDocument(document)).toThrow();
    expect(() => evaluateDocument(document, {})).toThrow();
  });

  test("refuses inherited fields and accessors without invoking them", () => {
    let invoked = false;
    const prototype = {
      get children() {
        invoked = true;
        return [];
      },
    };
    const inherited = Object.create(prototype) as ContentDocument;
    inherited.type = "root";
    expect(validateDocument(inherited)).toMatchObject([{ id: "topik-node-invalid" }]);
    expect(invoked).toBe(false);
    const hidden = { type: "root" } as ContentDocument;
    Object.defineProperty(hidden, "children", { value: [], enumerable: false });
    expect(validateDocument(hidden)).toMatchObject([{ id: "topik-node-invalid" }]);
  });

  test.each(["```a&#x20;b\ncode\n```", "```a&#xA;b\ncode\n```", "| a | b |\n| - | - |\n| x |"])(
    "accepts encoded code languages and ragged GFM tables: %s",
    (source) => {
      const document = parse(source);
      const canonical = writeDocument(document);
      expect(writeDocument(parse(canonical))).toBe(canonical);
    },
  );

  test("accepts ordinary mdast nodes with omitted optional resource fields", () => {
    const document = root(paragraph({ type: "link", url: "/guide", children: [text()] }));
    expect(validateDocument(document)).toEqual([]);
    expect(writeDocument(document)).toBe("[Text](/guide)\n");
    expect(writeDocument(root(paragraph({ type: "image", url: "/image.png" })))).toBe(
      "![](/image.png)\n",
    );
  });

  test.each(["#\n", ">\n", "-\n", "```\n```", "**&#x20;**", "[ ](/guide)", "[a\\\n](/x)"])(
    "retains representable empty and whitespace content: %s",
    (source) => {
      const document = parse(source);
      expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
    },
  );
});

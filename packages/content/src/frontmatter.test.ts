import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument, type ContentDocument } from "./index.js";
import { parse, withoutPositions } from "./test-helpers.js";

test("leading YAML frontmatter remains an inert root node through source writing", () => {
  const source =
    '---\ntitle: First lesson\nsummary: "Use {% $student.name %} literally"\n---\n\n# Welcome\n\nBody.';
  const document = parse(source);
  expect(document.children).toMatchObject([
    { type: "yaml", value: 'title: First lesson\nsummary: "Use {% $student.name %} literally"' },
    { type: "heading" },
    { type: "paragraph" },
  ]);
  const written = writeDocument(document);
  expect(written).toContain('summary: "Use {% $student.name %} literally"');
  expect(withoutPositions(parse(written))).toEqual(withoutPositions(document));
  expect(writeDocument(parse(written))).toBe(written);
});

test("a later --- remains Markdown and a misplaced YAML node is refused", () => {
  const document = parse("# Welcome\n\n---\n\nBody.");
  expect(document.children.map((child) => child.type)).toEqual([
    "heading",
    "thematicBreak",
    "paragraph",
  ]);
  const invalid = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "text", value: "First." }] },
      { type: "yaml", value: "title: Late" },
    ],
  } as ContentDocument;
  expect(() => writeDocument(invalid)).toThrow("YAML frontmatter must be the first root child");
  expect(parseDocument("---\ntitle: First\n---\n\nText.").ok).toBe(true);
});

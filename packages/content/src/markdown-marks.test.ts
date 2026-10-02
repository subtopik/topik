import { expect, test } from "vite-plus/test";
import {
  formatDocument,
  formatTopikContent,
  parseDocument,
  validateDocument,
  writeDocument,
  type ContentDocument,
} from "./index.js";
import type { PhrasingContent } from "mdast";
import { parse, withoutPositions } from "./test-helpers.js";

test.each([
  "*first*_second_",
  "**first**__second__",
  "**_first_**_second_",
  "***_first_** **_second_***",
  "__*first*__middle__*last*__",
  "_first_**second**_third_",
  "~~*first*_second_~~",
  "{% badge %}*first*_second_{% /badge %}",
  "| *first*_second_ |\n| --- |",
])("preserves adjacent mark boundaries: %s", (source) => {
  const document = parse(source);
  const written = writeDocument(document);
  expect(withoutPositions(parse(written))).toEqual(withoutPositions(document));
  expect(writeDocument(parse(written))).toBe(written);
  expect(formatTopikContent(source)).toMatchObject({ ok: true, formatted: written });
});

test.each(["*hello*", "**hello**"])(
  "writes a single %s mark with the installed Markdown writer",
  (source) => {
    const document = parse(source);
    const written = writeDocument(document);
    expect(withoutPositions(parse(written))).toEqual(withoutPositions(document));
  },
);

test.each([
  "****a*b*c",
  "****https://example.test/a*b*c",
  "******https://example.test/a**b**c",
  "********https://example.test/a**b**c",
  "*before **https://example.test** after*",
  "**before *https://example.test* after**",
])("preserves adjacent literal delimiters and nested marks: %s", (source) => {
  const document = parse(source);
  const written = writeDocument(document);
  const reopened = parse(written);
  expect(withoutPositions(reopened)).toEqual(withoutPositions(document));
  expect(writeDocument(reopened)).toBe(written);
});

function nestedMarks(kind: "emphasis" | "strong" | "delete", depth: number): ContentDocument {
  let child: PhrasingContent = {
    type: "link",
    url: "https://example.test",
    title: null,
    children: [{ type: "text", value: "Example" }],
  };
  for (let index = 0; index < depth; index++) {
    child = { type: kind, children: [child, { type: "text", value: "x" }] };
  }
  return {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: "**" }, child] }],
  };
}

test.each(["emphasis", "strong"] as const)(
  "preserves two caller-created %s levels around a link",
  (kind) => {
    const document = nestedMarks(kind, 2);
    const written = writeDocument(document);
    const reopened = parse(written);
    expect(withoutPositions(reopened)).toEqual(document);
    expect(writeDocument(reopened)).toBe(written);
  },
);

test.each(["emphasis", "strong"] as const)(
  "refuses three caller-created %s levels before writing",
  (kind) => {
    const document = nestedMarks(kind, 3);
    expect(validateDocument(document)).toMatchObject([{ id: "topik-mark-nesting" }]);
    expect(() => writeDocument(document)).toThrow("at most two nesting levels");
  },
);

test.each([
  "****a*b*c*",
  "****https://example.test/a*b*c*",
  "********a**b**c**",
  "********https://example.test/a**b**c**",
  "~~outer ~inner~ outer~~",
])("retains original source when nested marks cannot be normalized: %s", (source) => {
  expect(parseDocument(source)).toMatchObject({
    ok: false,
    source,
    diagnostics: [{ id: "topik-mark-nesting" }],
  });
  expect(formatDocument(source)).toMatchObject({ ok: false, source });
  expect(formatDocument(source)).not.toHaveProperty("formatted");
});

test("refuses repeated strikethrough before a lossy write", () => {
  const document = nestedMarks("delete", 2);
  expect(validateDocument(document)).toMatchObject([{ id: "topik-mark-nesting" }]);
  expect(() => writeDocument(document)).toThrow("Strikethrough marks cannot be nested");
});

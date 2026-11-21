import { expect, test } from "vite-plus/test";
import {
  formatDocument,
  formatTopikContent,
  parseDocument,
  rewriteTopikAssetOccurrences,
  sameDocumentMeaning,
  validateDocument,
  writeDocument,
  type ContentDocument,
} from "./index.js";
import type { PhrasingContent } from "mdast";
import { parse, withoutPositions } from "./test-helpers.js";

test.each([
  ["*first*_second_", "_firstsecond_\n"],
  ["**first**__second__", "**firstsecond**\n"],
  ["**_first_**_second_", "_**first**second_\n"],
  ["***_first_** **_second_***", "_**first** **second**_\n"],
  ["__*first*__middle__*last*__", "***first*middle*last***\n"],
  ["~~*first*_second_~~", "_~~firstsecond~~_\n"],
  ["{% badge %}*first*_second_{% /badge %}", "{% badge %}_firstsecond_{% /badge %}\n"],
  ["| *first*_second_ |\n| --- |", "| _firstsecond_ |\n| ------------- |\n"],
])("writes adjacent marks as one canonical span: %s", (source, expected) => {
  const document = parse(source);
  const written = writeDocument(document);
  expect(written).toBe(expected);
  expect(sameDocumentMeaning(parse(written), document)).toBe(true);
  expect(writeDocument(parse(written))).toBe(written);
  expect(formatTopikContent(source)).toMatchObject({ ok: true, formatted: written });
});

// Newer Markdown writers swap a delimiter that touches its parent's delimiter
// and then encode the letters next to it, as in `**&#x61;_&#x62;_**`.
test.each([
  ["**a*b***_c_", "**a*b***_c_\n"],
  ["__*first*__middle__*last*__", "**_first_**middle**_last_**\n"],
  ["***_a_****_a_***", "_**_a_**__*a*___\n"],
])("targeted rewrites keep authored marks without character references: %s", (source, expected) => {
  const rewritten = rewriteTopikAssetOccurrences(source, () => undefined);
  expect(rewritten).toMatchObject({ ok: true, content: expected });
  if (!rewritten.ok) throw new Error("Expected rewritten content");
  expect(withoutPositions(parse(rewritten.content))).toEqual(withoutPositions(parse(source)));
});

test.each([
  "*first* *second*",
  "**first** __second__",
  "*first*~~second~~",
  "_first_**second**_third_",
])("preserves mark boundaries that differ in their marks: %s", (source) => {
  const document = parse(source);
  const written = writeDocument(document);
  expect(withoutPositions(parse(written))).toEqual(withoutPositions(document));
  expect(writeDocument(parse(written))).toBe(written);
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
  expect(sameDocumentMeaning(reopened, document)).toBe(true);
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
  "collapses two caller-created %s levels around a link into one mark",
  (kind) => {
    const document = nestedMarks(kind, 2);
    const original = structuredClone(document);
    const written = writeDocument(document);
    expect(document).toEqual(original);
    const reopened = parse(written);
    expect(withoutPositions(reopened)).toEqual({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "**" },
            {
              type: kind,
              children: [
                {
                  type: "link",
                  url: "https://example.test",
                  title: null,
                  children: [{ type: "text", value: "Example" }],
                },
                { type: "text", value: "xx" },
              ],
            },
          ],
        },
      ],
    });
    expect(sameDocumentMeaning(reopened, document)).toBe(true);
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

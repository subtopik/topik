import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("block math keeps its literal content property", () => {
  const document = parse('{% math content="x^2 + y^2" /%}');
  expect(document.children[0]).toMatchObject({
    name: "math",
    props: { content: "x^2 + y^2" },
    children: [],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("math refuses missing content and a paired body", () => {
  for (const source of [
    "{% math /%}",
    "{% math content=3 /%}",
    '{% math content="x" %}\n\nText.\n\n{% /math %}',
  ])
    expect(parseDocument(source)).toMatchObject({ ok: false, source });
});

test("inline math survives inside prose without interpreting its content", () => {
  const document = parse('Area: {% mathInline content="r^2" /%}.');
  expect(document.children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text" },
      { name: "mathInline", props: { content: "r^2" } },
      { type: "text" },
    ],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("inline math requires a string content property", () => {
  const source = "{% mathInline content=true /%}";
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: false, source });
  if (!result.ok)
    expect(result.diagnostics.map((item) => item.id)).toContain("attribute-type-invalid");
});

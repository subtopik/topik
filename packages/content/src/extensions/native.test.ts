import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("native links, images, code, and tables remain standard Markdown nodes", () => {
  const source =
    'See [guide](/docs "Read") and ![hero](asset:hero).\n\n```ts\nconst x = 1;\n```\n\n| A |\n| --- |\n| B |';
  const document = parse(source);
  expect(document.children).toMatchObject([
    {
      type: "paragraph",
      children: [
        { type: "text" },
        { type: "link" },
        { type: "text" },
        { type: "image" },
        { type: "text" },
      ],
    },
    { type: "code", lang: "ts" },
    { type: "table" },
  ]);
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("native catalog names do not silently become authored component tags", () => {
  const source = '{% image src="asset:hero" /%}';
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: false, source });
});

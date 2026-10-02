import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("figure retains camelCase darkSrc and distinct light/dark assets", () => {
  const source = '{% figure src="asset:light" darkSrc="asset:dark" alt="Hero" caption="Intro" /%}';
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    name: "figure",
    props: {
      src: "asset:light",
      darkSrc: "asset:dark",
      alt: "Hero",
      caption: "Intro",
    },
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("figure requires its source and alt text", () => {
  for (const source of ['{% figure alt="Hero" /%}', '{% figure src="asset:hero" /%}']) {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok)
      expect(result.diagnostics.map((item) => item.id)).toContain("attribute-missing-required");
  }
});

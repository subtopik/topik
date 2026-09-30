import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("underline and u aliases preserve their authored names and inline children", () => {
  for (const name of ["underline", "u"]) {
    const source = `Text {% ${name} %}**important**{% /${name} %}.`;
    const document = parse(source);
    expect(document.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text" }, { name, children: [{ type: "strong" }] }, { type: "text" }],
    });
    expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
  }
});

test("underline refuses a self-closing empty body", () => {
  const source = "{% underline /%}";
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: false, source });
});

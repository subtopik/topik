import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("card accepts either a self-closing summary or flow body", () => {
  for (const source of [
    '{% card title="Setup" href="/start" /%}',
    '{% card title="Setup" %}\n\nRead the guide.\n\n{% /card %}',
  ]) {
    const document = parse(source);
    expect(document.children[0]).toMatchObject({ name: "card", props: { title: "Setup" } });
    expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
  }
});

test("card requires a string title", () => {
  const source = "{% card title=3 /%}";
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: false, source });
  if (!result.ok)
    expect(result.diagnostics.map((item) => item.id)).toContain("attribute-type-invalid");
});

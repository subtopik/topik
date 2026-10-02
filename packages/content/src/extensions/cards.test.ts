import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("cardGrid retains numeric columns and ordered card children", () => {
  const source =
    '{% cardGrid columns=2 %}\n\n{% card title="First" /%}\n\n{% card title="Second" /%}\n\n{% /cardGrid %}';
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    name: "cardGrid",
    props: { columns: 2 },
    children: [{ name: "card" }, { name: "card" }],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("cardGrid enforces direct card children and integer column range", () => {
  for (const [source, id] of [
    ["{% cardGrid columns=5 %}\n\n{% /cardGrid %}", "topik-columns-range"],
    ["{% cardGrid columns=1.5 %}\n\n{% /cardGrid %}", "topik-columns-range"],
    ["{% cardGrid %}\n\nParagraph.\n\n{% /cardGrid %}", "topik-card-grid-children"],
  ]) {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics.map((item) => item.id)).toContain(id);
  }
});

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

import { expect, test } from "vite-plus/test";
import { formatTopikContent, parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

function diagnosticIds(source: string): (string | undefined)[] {
  const result = parseDocument(source);
  return result.ok ? [] : result.diagnostics.map((item) => item.id);
}

test("kbd marks keys inside prose and round-trips", () => {
  const source = "Press {% kbd %}Ctrl{% /kbd %}+{% kbd %}C{% /kbd %} to copy.";
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "Press " },
      { type: "topikComponent", name: "kbd", children: [{ type: "text", value: "Ctrl" }] },
      { type: "text", value: "+" },
      { type: "topikComponent", name: "kbd", children: [{ type: "text", value: "C" }] },
      { type: "text", value: " to copy." },
    ],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
  expect(formatTopikContent(source)).toMatchObject({ ok: true, formatted: `${source}\n` });
});

test("kbd works in headings, lists and table cells", () => {
  const source = [
    "## Save with {% kbd %}Ctrl{% /kbd %}+{% kbd %}S{% /kbd %}",
    "",
    "- Undo: {% kbd %}Ctrl{% /kbd %}+{% kbd %}Z{% /kbd %}",
    "",
    "| Action | Keys |",
    "| --- | --- |",
    "| Search | {% kbd %}/{% /kbd %} |",
  ].join("\n");
  expect(parseDocument(source)).toMatchObject({ ok: true });
});

test("kbd needs a key name", () => {
  expect(diagnosticIds("Press {% kbd %}{% /kbd %} now.")).toContain("topik-kbd-children");
});

test("kbd is inline only, like underline", () => {
  // Tags on their own lines inside one paragraph are still inline; a block body is refused.
  expect(parseDocument("{% kbd %}\nCtrl\n{% /kbd %}")).toMatchObject({ ok: true });
  expect(diagnosticIds("{% kbd %}\n\nCtrl\n\n{% /kbd %}")).not.toEqual([]);
});

test("kbd takes no attributes", () => {
  expect(diagnosticIds('Press {% kbd key="Enter" %}Enter{% /kbd %}.')).toContain(
    "attribute-undefined",
  );
});

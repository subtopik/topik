import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("accordion keeps a boolean open property and block body", () => {
  const document = parse(
    '{% accordion title="Details" open=true %}\n\nMore **here**.\n\n{% /accordion %}',
  );
  expect(document.children[0]).toMatchObject({
    name: "accordion",
    props: { title: "Details", open: true },
    children: [{ type: "paragraph" }],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("accordion requires a title and a boolean open value", () => {
  for (const [source, id] of [
    ["{% accordion %}\n\nBody.\n\n{% /accordion %}", "attribute-missing-required"],
    [
      '{% accordion title="Details" open="true" %}\n\nBody.\n\n{% /accordion %}',
      "attribute-type-invalid",
    ],
  ]) {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics.map((item) => item.id)).toContain(id);
  }
});

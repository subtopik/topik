import { expect, test } from "vite-plus/test";
import { components, getEffectiveProps, parseDocument, writeDocument } from "../index.js";
import type { Component } from "../model.js";
import { parse, withoutPositions } from "../test-helpers.js";

function diagnosticIds(source: string): (string | undefined)[] {
  const result = parseDocument(source);
  return result.ok ? [] : result.diagnostics.map((item) => item.id);
}

test("columns keep their count and ordered cells", () => {
  const source = [
    "{% columns count=3 %}",
    "",
    '{% card title="Install" href="./install" /%}',
    "",
    "{% column %}",
    "",
    "Any **block** content.",
    "",
    "{% /column %}",
    "",
    '{% card title="Deploy" %}',
    "",
    "Body.",
    "",
    "{% /card %}",
    "",
    "{% /columns %}",
  ].join("\n");
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    name: "columns",
    props: { count: 3 },
    children: [{ name: "card" }, { name: "column" }, { name: "card" }],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("columns default to two", () => {
  const document = parse("{% columns %}\n{% column %}\nA\n{% /column %}\n{% /columns %}");
  const node = document.children[0] as unknown as Component;
  expect(node.props).toEqual({});
  expect(getEffectiveProps(node, components)).toMatchObject({ count: 2 });
});

test("a column holds any block content", () => {
  const source = [
    "{% columns %}",
    "{% column %}",
    "",
    "- A list",
    "",
    "```ts",
    "const code = true;",
    "```",
    "",
    '{% figure src="images/a.png" alt="Diagram" /%}',
    "",
    '{% callout variant="tip" %}',
    "Nested components.",
    "{% /callout %}",
    "{% /column %}",
    "{% /columns %}",
  ].join("\n");
  expect(parseDocument(source)).toMatchObject({ ok: true });
});

test.each([
  ['{% columns count=5 %}\n{% card title="A" /%}\n{% /columns %}', "topik-count-range"],
  ['{% columns count=0 %}\n{% card title="A" /%}\n{% /columns %}', "topik-count-range"],
  ['{% columns count=1.5 %}\n{% card title="A" /%}\n{% /columns %}', "topik-count-range"],
  ["{% columns %}\nParagraph.\n{% /columns %}", "topik-columns-children"],
  ["{% columns %}\n{% /columns %}", "topik-columns-requires-card"],
  ["{% column %}\nA\n{% /column %}", "topik-columns-parent-required"],
  [
    '{% tabs %}\n{% tab title="A" %}\n{% column %}\nA\n{% /column %}\n{% /tab %}\n{% /tabs %}',
    "topik-columns-parent-required",
  ],
])("refuses %j with %s", (source, id) => {
  expect(diagnosticIds(source)).toContain(id);
});

test("columns are placed wherever block content is", () => {
  const cells = '{% columns %}\n{% card title="A" /%}\n{% card title="B" /%}\n{% /columns %}';
  for (const source of [
    cells,
    `{% tabs %}\n{% tab title="A" %}\n${cells}\n{% /tab %}\n{% /tabs %}`,
    `{% steps %}\n{% step %}\n${cells}\n{% /step %}\n{% /steps %}`,
    `{% accordion title="More" %}\n${cells}\n{% /accordion %}`,
  ])
    expect(parseDocument(source)).toMatchObject({ ok: true });
  expect(diagnosticIds(`Text ${cells}`)).not.toEqual([]);
});

test("an empty layout names both cell kinds", () => {
  const result = parseDocument("{% columns %}\n{% /columns %}");
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "topik-columns-requires-card",
        message: expect.stringContaining("card or column"),
      }),
    );
});

test("columns take cards or columns, and require neither kind alone", () => {
  expect(components.columns.children).toEqual({ components: ["card", "column"], min: 1 });
});

test("a card still stands alone outside columns", () => {
  expect(parseDocument('{% card title="Setup" href="/start" /%}')).toMatchObject({ ok: true });
});

test("cardGrid is no longer a component", () => {
  expect(diagnosticIds('{% cardGrid %}\n{% card title="A" /%}\n{% /cardGrid %}')).toContain(
    "tag-undefined",
  );
});

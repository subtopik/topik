import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("steps preserves ordered step bodies", () => {
  const source =
    '{% steps %}\n\n{% step title="Prepare" %}\n\nFirst.\n\n{% /step %}\n\n{% step %}\n\nSecond.\n\n{% /step %}\n\n{% /steps %}';
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    name: "steps",
    children: [
      { name: "step", props: { title: "Prepare" } },
      { name: "step", props: {} },
    ],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("steps requires a step child", () => {
  const source = "{% steps %}\n\n{% /steps %}";
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: false, source });
  if (!result.ok)
    expect(result.diagnostics.map((item) => item.id)).toContain("topik-steps-requires-step");
});

test("step keeps an optional empty title and nested flow content", () => {
  const source =
    '{% steps %}\n\n{% step title="" %}\n\n- One\n- Two\n\n{% /step %}\n\n{% /steps %}';
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    children: [{ name: "step", props: { title: "" }, children: [{ type: "list" }] }],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("a step outside steps is refused", () => {
  const source = "{% step %}\n\nLoose.\n\n{% /step %}";
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: false, source });
  if (!result.ok)
    expect(result.diagnostics.map((item) => item.id)).toContain("topik-steps-parent-required");
});

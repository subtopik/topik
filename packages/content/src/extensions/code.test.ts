import { expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("codeGroup preserves ordered code tabs", () => {
  const source =
    '{% codeGroup %}\n\n{% codeTab title="TypeScript" %}\n\n```ts\nconst a = 1;\n```\n\n{% /codeTab %}\n\n{% codeTab title="Python" %}\n\n```py\na = 1\n```\n\n{% /codeTab %}\n\n{% /codeGroup %}';
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    name: "codeGroup",
    children: [
      {
        name: "codeTab",
        props: { title: "TypeScript" },
        children: [{ type: "code", lang: "ts", value: "const a = 1;" }],
      },
      {
        name: "codeTab",
        props: { title: "Python" },
        children: [{ type: "code", lang: "py", value: "a = 1" }],
      },
    ],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("codeGroup requires codeTab children", () => {
  for (const [source, id] of [
    ["{% codeGroup %}\n\n{% /codeGroup %}", "topik-code-group-requires-code-tab"],
    ["{% codeGroup %}\n\nPlain text.\n\n{% /codeGroup %}", "topik-code-group-children"],
  ]) {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics.map((item) => item.id)).toContain(id);
  }
});

test("codeTab requires a title, code, and a codeGroup parent", () => {
  for (const [source, id] of [
    [
      "{% codeGroup %}\n\n{% codeTab %}\n\n```\nx\n```\n\n{% /codeTab %}\n\n{% /codeGroup %}",
      "attribute-missing-required",
    ],
    [
      '{% codeTab title="Loose" %}\n\n```\nx\n```\n\n{% /codeTab %}',
      "topik-code-group-parent-required",
    ],
    [
      '{% codeGroup %}\n\n{% codeTab title="Empty" %}\n\n{% /codeTab %}\n\n{% /codeGroup %}',
      "topik-code-tab-requires-fence",
    ],
  ]) {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics.map((item) => item.id)).toContain(id);
  }
});

import { expect, test } from "vite-plus/test";
import { compileTopikContent, ContentTag, parseDocument, transformTopikContent } from "./index.js";

function presented(payload: string, options = "lines=false", template = false): string {
  return [
    ...(template ? ["{% template code %}"] : []),
    `~~~unknown-text ${options}`,
    payload,
    "~~~",
    ...(template ? ["{% /template code %}"] : []),
  ].join("\n");
}

test("reader payload, copy, physical rows and effective options preserve authored whitespace", () => {
  const payload = "\tfirst  \n+second\n-old\n";
  const source = presented(
    payload,
    'startLine=10 highlight="4,2-3,2" focus="2" added="2" removed="3" collapseAfter=1',
  );
  const parsed = parseDocument(source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const before = structuredClone(parsed.document);
  const tree = transformTopikContent(parsed.document) as ContentTag;
  expect(tree.children).toEqual([
    new ContentTag("TopikCodeBlock", {
      payload,
      content: `${payload}\n`,
      language: "unknown-text",
      presentation: {
        lineNumbers: false,
        startLine: 10,
        wrap: false,
        highlight: [[2, 4]],
        focus: [[2, 2]],
        added: [[2, 2]],
        removed: [[3, 3]],
        collapseAfter: 1,
      },
    }),
  ]);
  expect(parsed.document).toEqual(before);
  const authored = parsed.document.children[0];
  if (authored.type !== "topikCodePresentation") throw new Error("Expected presentation");
  authored.options.highlight = [
    [4, 4],
    [2, 3],
    [2, 2],
  ];
  const callerBefore = structuredClone(parsed.document);
  expect(transformTopikContent(parsed.document)).toEqual(tree);
  expect(parsed.document).toEqual(callerBefore);
});

test("empty payload has one row and copies one separator LF", () => {
  const result = compileTopikContent(presented("", 'highlight="1"'));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const code = (result.tree as ContentTag).children[0] as ContentTag;
  expect(code.attributes.payload).toBe("");
  expect(code.attributes.content).toBe("\n");
  expect((code.attributes.presentation as { highlight: unknown }).highlight).toEqual([[1, 1]]);
});

test("templates resolve before presentation without changing authored options or row coordinates", () => {
  const source = presented("{% $value %}\nlast", 'focus="2" collapseAfter=1', true);
  const result = compileTopikContent(source, { config: { variables: { value: "<&>" } } });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const code = (result.tree as ContentTag).children[0] as ContentTag;
  expect(code.attributes.payload).toBe("<&>\nlast");
  expect(code.attributes.content).toBe("<&>\nlast\n");
  expect(result.source).toBe(source);
});

test("decoration budget fails all-or-nothing in selected and inactive branches", () => {
  const large = presented("\n".repeat(11_000));
  for (const source of [large, `{% if false %}\n${large}\n{% /if %}`]) {
    const result = compileTopikContent(source);
    expect(result.ok).toBe(false);
    expect(result.source).toBe(source);
    expect(result.diagnostics.some(({ id }) => id === "topik-content-limit")).toBe(true);
    expect("tree" in result).toBe(false);
  }
});

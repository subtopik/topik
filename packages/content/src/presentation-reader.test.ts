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
    'startLine=10 highlight="4,2-3,2" focus="2" added="2" removed="3" collapse="2-3"',
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
        collapse: [[2, 3]],
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
  const result = compileTopikContent(presented("", 'highlight="1" collapse="1"'));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const code = (result.tree as ContentTag).children[0] as ContentTag;
  expect(code.attributes.payload).toBe("");
  expect(code.attributes.content).toBe("\n");
  expect(code.attributes.presentation).toMatchObject({ highlight: [[1, 1]], collapse: [[1, 1]] });
});

test("templates resolve before presentation without changing authored options or row coordinates", () => {
  const source = presented("{% $value %}\nlast", 'focus="2" collapse="1-2"', true);
  const result = compileTopikContent(source, { config: { variables: { value: "<&>" } } });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const code = (result.tree as ContentTag).children[0] as ContentTag;
  expect(code.attributes.payload).toBe("<&>\nlast");
  expect(code.attributes.content).toBe("<&>\nlast\n");
  expect(code.attributes.presentation).toMatchObject({ focus: [[2, 2]], collapse: [[1, 2]] });
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

test("reader exposes independent normalized collapse regions in physical coordinates", () => {
  const payload = "a\nb\nc\nd\ne\nf\ng\nh\ni";
  const result = compileTopikContent(presented(payload, 'startLine=100 collapse="9,3,8-9,4"'));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const code = (result.tree as ContentTag).children[0] as ContentTag;
  expect(code.attributes.payload).toBe(payload);
  expect(code.attributes.content).toBe(payload + "\n");
  expect(code.attributes.presentation).toMatchObject({
    startLine: 100,
    collapse: [
      [3, 4],
      [8, 9],
    ],
  });
});

test("decoration budget counts normalized independent fold controls in every branch", () => {
  const payload = "\n".repeat(9_999);
  expect(compileTopikContent(presented(payload)).ok).toBe(true);
  const merged = Array.from({ length: 1024 }, () => "1").join(",");
  expect(compileTopikContent(presented(payload, `collapse="${merged}"`)).ok).toBe(true);
  const regions = Array.from({ length: 1024 }, (_, index) => String(index * 2 + 1)).join(",");
  const source = presented(payload, `collapse="${regions}"`);
  for (const authored of [source, `{% if false %}\n${source}\n{% /if %}`]) {
    const result = compileTopikContent(authored);
    expect(result.ok).toBe(false);
    expect(result.source).toBe(authored);
    expect(result.diagnostics.some(({ id }) => id === "topik-content-limit")).toBe(true);
    expect("tree" in result).toBe(false);
  }
});

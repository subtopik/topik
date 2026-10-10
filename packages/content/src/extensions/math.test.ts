import { expect, test } from "vite-plus/test";
import {
  compileTopikContent,
  formatTopikContent,
  parseDocument,
  rewriteTopikAssetOccurrences,
  sameDocumentMeaning,
  writeDocument,
} from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

test("block math keeps its literal content property", () => {
  const document = parse('{% math content="x^2 + y^2" /%}');
  expect(document.children[0]).toMatchObject({
    name: "math",
    props: { content: "x^2 + y^2" },
    children: [],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("math refuses missing content and a paired body", () => {
  for (const source of [
    "{% math /%}",
    "{% math content=3 /%}",
    '{% math content="x" %}\n\nText.\n\n{% /math %}',
  ])
    expect(parseDocument(source)).toMatchObject({ ok: false, source });
});

test("inline math survives inside prose without interpreting its content", () => {
  const document = parse('Area: {% mathInline content="r^2" /%}.');
  expect(document.children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text" },
      { name: "mathInline", props: { content: "r^2" } },
      { type: "text" },
    ],
  });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
});

test("inline math requires a string content property", () => {
  const source = "{% mathInline content=true /%}";
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: false, source });
  if (!result.ok)
    expect(result.diagnostics.map((item) => item.id)).toContain("attribute-type-invalid");
});

test("math whitespace escapes preserve formula bytes through parsing, writing and rendering", () => {
  const formula = '  \\frac{"α"}{x_{2}}\r\n + β\t\\text{ /%} }  ';
  const value = JSON.stringify(formula);
  const source = `Before {% mathInline content=${value} /%} after.\n\n{% math content=${value} /%}`;
  const document = parse(source);
  expect(document.children[0]).toMatchObject({
    children: [{ type: "text" }, { props: { content: formula } }, { type: "text" }],
  });
  expect(document.children[1]).toMatchObject({ props: { content: formula } });
  expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
  expect(formatTopikContent(source).ok).toBe(true);
  expect(compileTopikContent(source).ok).toBe(true);
});

test("math whitespace admission does not allow raw line breaks, other controls or escapes in other attributes", () => {
  for (const source of [
    '{% math content="a\nb" /%}',
    '{% math content="a\u0007b" /%}',
    String.raw`{% math content="a\u0007b" /%}`,
    String.raw`{% callout title="a\nb" %}` + "\nBody\n{% /callout %}",
  ])
    expect(parseDocument(source).ok).toBe(false);
});

test("formatting and asset rewriting preserve math bytes beside unevaluated text and code templates", () => {
  const formula = "x\r\n + y\t{% $literal %}";
  const source = [
    '{% callout title=t"Install {% $package.name %}" %}',
    `{% math content=${JSON.stringify(formula)} /%}`,
    "{% template code %}",
    "```sh",
    "npm install {% $package.name %}",
    "```",
    "{% /template code %}",
    '{% figure src="./image.png" alt=t"{% $package.name %}" /%}',
    "{% /callout %}",
  ].join("\n");
  const document = parse(source);
  const formatted = formatTopikContent(source);
  expect(formatted).toMatchObject({ ok: true, source });
  if (!formatted.ok) throw new Error("Expected supported math and template source");
  expect(sameDocumentMeaning(document, parse(formatted.formatted))).toBe(true);
  expect(formatTopikContent(formatted.formatted)).toMatchObject({
    ok: true,
    formatted: formatted.formatted,
  });

  const rewritten = rewriteTopikAssetOccurrences(source, () => "./replacement.png");
  expect(rewritten).toMatchObject({ ok: true });
  if (!rewritten.ok) throw new Error("Expected supported asset replacement");
  const rewrittenDocument = parse(rewritten.content);
  expect(rewrittenDocument.children[0]).toMatchObject({
    props: {
      title: {
        type: "topikTextTemplate",
        segments: [
          { type: "literal", value: "Install " },
          { type: "variable", path: ["package", "name"] },
        ],
      },
    },
    children: [
      { props: { content: formula } },
      { type: "topikCodeTemplate" },
      { props: { src: "./replacement.png", alt: { type: "topikTextTemplate" } } },
    ],
  });
  expect(
    compileTopikContent(rewritten.content, {
      config: { variables: { package: { name: "example-kit" } } },
    }),
  ).toMatchObject({
    ok: true,
    tree: {
      children: [
        {
          attributes: { title: "Install example-kit" },
          children: [
            { attributes: { content: formula } },
            { attributes: { content: "npm install example-kit\n" } },
            { attributes: { src: "./replacement.png", alt: "example-kit" } },
          ],
        },
      ],
    },
  });
});

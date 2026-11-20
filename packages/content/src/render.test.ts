import { expect, test } from "vite-plus/test";
import {
  components,
  isContentTag,
  parseDocument,
  parseTopikContent,
  transformTopikContent,
  validateTopikContent,
  type TopikContentConfig,
} from "./index.js";

test("custom render names and typed defaults produce an independent serializable tree", () => {
  const config: TopikContentConfig = {
    components: {
      notice: {
        kind: "block",
        render: "ExternalNotice",
        attributes: { level: { type: "number", default: 2 } },
        children: "blocks",
      },
    },
  };
  const source = "{% notice %}\nKeep a **backup**.\n{% /notice %}";
  expect(validateTopikContent(source, { config }).valid).toBe(true);
  const document = parseTopikContent(source, { config });
  const original = structuredClone(document);
  const tree: unknown = JSON.parse(JSON.stringify(transformTopikContent(document, config)));
  expect(isContentTag(tree)).toBe(true);
  expect(tree).toEqual({
    type: "element",
    name: "article",
    attributes: {},
    children: [
      {
        type: "element",
        name: "ExternalNotice",
        attributes: { level: 2 },
        children: [
          {
            type: "element",
            name: "p",
            attributes: {},
            children: [
              "Keep a ",
              { type: "element", name: "strong", attributes: {}, children: ["backup"] },
              ".",
            ],
          },
        ],
      },
    ],
  });
  expect(document).toEqual(original);
});

test("declarative rendering can expose children or omit a component", () => {
  const config: TopikContentConfig = {
    components: {
      transparent: { kind: "block", render: true, attributes: {}, children: "blocks" },
      omitted: { kind: "block", render: false, attributes: {}, children: "blocks" },
    },
  };
  const source = [
    "{% transparent %}",
    "Shown.",
    "{% /transparent %}",
    "{% omitted %}",
    "Not rendered.",
    "{% /omitted %}",
  ].join("\n");
  expect(validateTopikContent(source, { config }).valid).toBe(true);
  const document = parseTopikContent(source, { config });
  expect(JSON.parse(JSON.stringify(transformTopikContent(document, config)))).toEqual({
    type: "element",
    name: "article",
    attributes: {},
    children: [[{ type: "element", name: "p", attributes: {}, children: ["Shown."] }], null],
  });
});

test("rendering resolves context as literal text and leaves the authored branches intact", () => {
  const source = [
    "{% if $teacher %}",
    "Teacher notes.",
    "{% else /%}",
    "Hello {% $name %}.",
    "{% /if %}",
  ].join("\n");
  expect(validateTopikContent(source).valid).toBe(true);
  const document = parseTopikContent(source);
  const original = structuredClone(document);
  const tree = transformTopikContent(document, {
    variables: { teacher: false, name: "**Ada** <script>" },
  });
  expect(JSON.parse(JSON.stringify(tree))).toEqual({
    type: "element",
    name: "article",
    attributes: {},
    children: [
      { type: "element", name: "p", attributes: {}, children: ["Hello **Ada** <script>."] },
    ],
  });
  expect(document).toEqual(original);
});

function attributesOf(tree: unknown, name: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isContentTag(value)) {
      if (value.name === name) found.push(value.attributes);
      value.children.forEach(visit);
    }
  };
  visit(tree);
  return found;
}

function transformUnadmitted(source: string, config: TopikContentConfig = {}): unknown {
  const parsed = parseDocument(source, { ...components, ...config.components });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return transformTopikContent(parsed.document, config);
}

test("the low-level transform drops URLs that fail the source URL policy", () => {
  const source = [
    "[x](javascript:alert(1)) ![i](javascript:alert(2)) [d](data:text/html,x) [v](VBScript:x)",
    "",
    "[e]() [p](//evil.example) [r][bad]",
    "",
    "[bad]: javascript:alert(3)",
    "",
    '{% figure src="javascript:alert(4)" darkSrc="data:image/png;base64,AA" alt="a" /%}',
    "",
    "{% columns %}",
    '{% card title="a" href="javascript:alert(5)" /%}',
    `{% card title="b" href="asset:auto-v1-${"a".repeat(52)}" /%}`,
    "{% /columns %}",
  ].join("\n");
  expect(validateTopikContent(source).valid).toBe(false);
  const tree = transformUnadmitted(source);

  expect(attributesOf(tree, "TopikLink")).toEqual([{}, {}, {}, {}, {}, {}]);
  expect(attributesOf(tree, "TopikImage")).toEqual([{ alt: "i" }]);
  expect(attributesOf(tree, "TopikFigure")).toEqual([{ alt: "a" }]);
  expect(attributesOf(tree, "TopikCard")).toEqual([{ title: "a" }, { title: "b" }]);
  expect(JSON.stringify(tree)).not.toMatch(/javascript|data:|vbscript|evil/i);
});

test("the low-level transform drops unsafe custom asset attributes only", () => {
  const config: TopikContentConfig = {
    components: {
      clip: {
        kind: "block",
        render: "Clip",
        attributes: {
          src: { type: "string", asset: true },
          label: { type: "string" },
        },
        children: "none",
        selfClosing: true,
      },
    },
  };
  const tree = transformUnadmitted(
    '{% clip src="javascript:alert(1)" label="javascript:x" /%}',
    config,
  );
  expect(attributesOf(tree, "Clip")).toEqual([{ label: "javascript:x" }]);
});

test("the low-level transform preserves URLs that admitted content may contain", () => {
  const asset = `asset:auto-v1-${"a".repeat(52)}`;
  const source = [
    "[a](https://example.com/a?b#c) [b](./page) [c](#top) [d](mailto:a@example.com) [e](ref://wiki-page/install)",
    "",
    `![i](images/a.png) ![j](https://example.com/j.png) ![k](${asset})`,
    "",
    '{% figure src="images/a.png" darkSrc="https://example.com/d.png" alt="a" /%}',
    "",
    "{% columns %}",
    '{% card title="a" href="ref://wiki-page/install" /%}',
    "{% /columns %}",
  ].join("\n");
  const tree = transformUnadmitted(source);
  expect(attributesOf(tree, "TopikLink").map((attributes) => attributes.href)).toEqual([
    "https://example.com/a?b#c",
    "./page",
    "#top",
    "mailto:a@example.com",
    "ref://wiki-page/install",
  ]);
  expect(attributesOf(tree, "TopikImage").map((attributes) => attributes.src)).toEqual([
    "images/a.png",
    "https://example.com/j.png",
    asset,
  ]);
  expect(attributesOf(tree, "TopikFigure")).toEqual([
    { src: "images/a.png", darkSrc: "https://example.com/d.png", alt: "a" },
  ]);
  expect(attributesOf(tree, "TopikCard")).toEqual([
    { title: "a", href: "ref://wiki-page/install" },
  ]);
});

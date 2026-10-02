import { expect, test } from "vite-plus/test";
import {
  isContentTag,
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

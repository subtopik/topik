import { expect, test } from "vite-plus/test";
import { convertTags, parseDocument, writeDocument } from "./markdown.js";
import { withoutPositions } from "./test-helpers.js";
import type { TreeNode } from "./model.js";
import { components } from "./registry.js";

test.each([
  "&#xA;hello",
  "hello&#xA;",
  "&#xA;",
  "a&#xA;&#xA;b",
  "a&#xA; &#xA;b",
  "**&#xA;hello&#xA;**",
  "| Cell |\n| --- |\n| a&#xA;&#xA;b |",
])("preserves newline characters encoded in text: %s", (source) => {
  const parsed = parseDocument(source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const written = writeDocument(parsed.document);
  const reopened = parseDocument(written);
  expect(reopened.ok).toBe(true);
  if (!reopened.ok) throw new Error(JSON.stringify(reopened.diagnostics));
  expect(withoutPositions(reopened.document)).toEqual(withoutPositions(parsed.document));
  expect(writeDocument(reopened.document)).toBe(written);
});

test.each(["textDirective", "leafDirective", "containerDirective"])(
  "does not convert foreign %s nodes into Topik components",
  (type) => {
    const foreign: TreeNode = { type, name: "callout", attributes: {}, children: [] };
    const own: TreeNode = { type: "tagContainer", name: "callout", attributes: {}, children: [] };
    const tree: TreeNode = { type: "root", children: [foreign, own] };
    const originalForeign = structuredClone(foreign);

    expect(convertTags(tree, components)).toEqual([]);
    expect(tree.children?.[0]).toEqual(originalForeign);
    expect(tree.children?.[1]).toMatchObject({
      type: "topikComponent",
      name: "callout",
      props: {},
      children: [],
    });
  },
);

import { describe, expect, test } from "vite-plus/test";
import type { Root, PhrasingContent } from "mdast";
import { meaning, parse, write } from "./test-support.js";
import { defaultHandlers, toMarkdown } from "mdast-util-to-markdown";
import { tagToMarkdown } from "./index.js";
import { declarations } from "./test-support.js";

describe.each(["*", "_"] as const)("with preferred mark delimiter %s", (delimiter) => {
  test.each(["emphasis", "strong"] as const)(
    "preserves nested %s across inline tag boundaries",
    (type) => {
      const outer = type === "emphasis" ? "_" : "__";
      const inner = type === "emphasis" ? "*" : "**";
      for (const nestedTags of [false, true]) {
        const body = `${inner}!word!${inner}`;
        const tag = `{% hint %}${nestedTags ? `{% badge %}${body}{% /badge %}` : body}{% /hint %}`;
        const tree = parse(`${outer}${tag}${outer} and *after*`);
        expect(tree.children[0]).toMatchObject({
          type: "paragraph",
          children: [
            { type, children: [{ type: "tagText", name: "hint" }] },
            { type: "text", value: " and " },
            { type: "emphasis" },
          ],
        });
        const write = (root: Root) =>
          toMarkdown(root, {
            extensions: [tagToMarkdown(declarations)],
            emphasis: delimiter,
            strong: delimiter,
          });
        const output = write(tree);
        const reparsed = parse(output);
        expect(meaning(reparsed), output).toEqual(meaning(tree));
        expect(write(reparsed)).toBe(output);
      }
    },
  );
});

test.each(["emphasis", "strong", "delete"] as const)(
  "preserves %s at inline tag boundaries",
  (type) => {
    for (const value of type === "delete"
      ? ["word", "!word!"]
      : ["word", "!word!", " word", "word "]) {
      const mark: PhrasingContent = { type, children: [{ type: "text", value }] };
      const tree: Root = {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: "before" },
              { type: "tagText", name: "hint", attributes: {}, children: [mark] },
              { type: "text", value: "after" },
            ],
          },
        ],
      };
      const output = write(tree);
      expect(meaning(parse(output)), output).toEqual(tree);
    }
  },
);

test("keeps an inline tag inside an autolink-shaped link", () => {
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: "https://example.com",
            title: null,
            children: [
              {
                type: "tagText",
                name: "hint",
                attributes: {},
                children: [{ type: "text", value: "https://example.com" }],
              },
            ],
          },
        ],
      },
    ],
  };
  expect(meaning(parse(write(tree)))).toEqual(tree);
});

test("serializes nested inline tags with work proportional to tree size", () => {
  const depth = 12;
  let child: PhrasingContent = { type: "inlineCode", value: "content" };
  for (let index = 0; index < depth; index++) {
    child = {
      type: "tagText",
      name: "hint",
      attributes: {},
      children: [{ type: "text", value: "before " }, child],
    };
  }
  const tree: Root = { type: "root", children: [{ type: "paragraph", children: [child] }] };
  let visits = 0;
  const output = toMarkdown(tree, {
    extensions: [tagToMarkdown(declarations)],
    handlers: {
      inlineCode(node, parent, state) {
        visits++;
        return defaultHandlers.inlineCode(node, parent, state);
      },
    },
  });
  expect(meaning(parse(output))).toEqual(tree);
  // Count work rather than timing: lookahead must not reserialize entire subtrees.
  expect(visits).toBeLessThanOrEqual(depth * 2);
});

import { fromMarkdown } from "mdast-util-from-markdown";
import { expect, test } from "vite-plus/test";
import { TAG_LIMITS, TagSyntaxError, tagFromMarkdown, tagSyntax } from "./index.js";

const tags = { badge: { kind: "inline" } } as const;

test.each([
  ["ordinary Markdown", "> ".repeat(TAG_LIMITS.treeDepth + 1) + "Text."],
  [
    "inline tags",
    "{% badge %}".repeat(TAG_LIMITS.treeDepth + 1) +
      "Text." +
      "{% /badge %}".repeat(TAG_LIMITS.treeDepth + 1),
  ],
  [
    "combined Markdown and tags",
    "> ".repeat(100) + "{% badge %}".repeat(64) + "Text." + "{% /badge %}".repeat(64),
  ],
])("refuses excessive %s depth with a controlled syntax error", (_name, source) => {
  let error: unknown;
  try {
    fromMarkdown(source, {
      extensions: [tagSyntax(tags)],
      mdastExtensions: [tagFromMarkdown(tags)],
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TagSyntaxError);
  expect(error).toMatchObject({ diagnostics: [{ id: "tag-content-limit" }] });
});

test("bounds wide incoming trees before allocating the traversal stack", () => {
  const transform = tagFromMarkdown({}).transforms![0];
  const children = Array.from({ length: TAG_LIMITS.treeNodes }, () => ({
    type: "thematicBreak" as const,
  }));
  expect(() => transform({ type: "root", children })).toThrow(TagSyntaxError);
});

import type { Root } from "mdast";
import type { TagTextNode } from "./index.js";
import { describe, expect, test } from "vite-plus/test";
import { meaning, parse, write } from "./test-support.js";

function document(node: TagTextNode): Root {
  return { type: "root", children: [{ type: "paragraph", children: [node] }] };
}

test.each([
  ["<https://example.com/{%>", "https://example.com/{%", "https://example.com/{%"],
  ["<{%@example.com>", "mailto:{%@example.com", "{%@example.com"],
])("preserves tag-looking text in the autolink %s", (source, url, label) => {
  const tree = parse(source);
  expect(tree.children[0]).toMatchObject({
    type: "paragraph",
    children: [{ type: "link", url, children: [{ type: "text", value: label }] }],
  });
  const output = write(tree);
  const reparsed = parse(output);
  expect(meaning(reparsed)).toEqual(meaning(tree));
  expect(write(reparsed)).toBe(output);
});

describe("independently constructed tag trees", () => {
  test("attribute ordering uses code units independently of the host locale", () => {
    const tree = document({
      type: "tagText",
      name: "badge",
      children: [],
      attributes: { ab: "lower", aB: "mixed", "a-b": "hyphen" },
    });
    expect(write(tree)).toBe('{% badge a-b="hyphen" aB="mixed" ab="lower" /%}\n');
  });

  test("omits absent values, preserves empty strings, sorts keys, and never mutates input", () => {
    const tree = document({
      type: "tagText",
      name: "badge",
      children: [],
      attributes: { z: "last", empty: "", absent: null, missing: undefined, a: "first" },
    });
    const original = structuredClone(tree);
    expect(write(tree)).toBe('{% badge a="first" empty="" z="last" /%}\n');
    expect(tree).toEqual(original);
    expect(meaning(parse(write(tree)))).toEqual(
      document({
        type: "tagText",
        name: "badge",
        children: [],
        attributes: { a: "first", empty: "", z: "last" },
      }),
    );
  });

  test("escapes quotes and backslashes without interpreting tag delimiters or entities", () => {
    const tree = document({
      type: "tagText",
      name: "badge",
      children: [],
      attributes: { label: 'a "quote" \\ path | {% %} &amp;' },
    });
    expect(write(tree)).toBe(
      String.raw`{% badge label="a \"quote\" \\ path | {% %} &amp;" /%}` + "\n",
    );
    expect(meaning(parse(write(tree)))).toEqual(tree);
  });

  test("writes a paired inline node with a link and emphasis", () => {
    const tree = document({
      type: "tagText",
      name: "hint",
      attributes: {},
      children: [
        {
          type: "link",
          url: "/guide",
          title: "Guide",
          children: [{ type: "emphasis", children: [{ type: "text", value: "Read" }] }],
        },
      ],
    });
    expect(write(tree)).toBe('{% hint %}[*Read*](/guide "Guide"){% /hint %}\n');
    expect(meaning(parse(write(tree)))).toEqual(tree);
  });

  test.each([
    [{ type: "tagText", name: "missing", children: [] }, /not declared inline/],
    [{ type: "tagText", children: [] }, /<missing>.*not declared inline/],
    [{ type: "tagText", name: "panel", children: [] }, /not declared inline/],
    [{ type: "tagLeaf", name: "badge", children: [] }, /not declared block/],
    [{ type: "tagContainer", name: "badge", children: [] }, /not declared block/],
    [
      { type: "tagText", name: "badge", children: [], attributes: { bad_key: "x" } },
      /Invalid attribute/,
    ],
    [
      { type: "tagText", name: "badge", children: [], attributes: { label: Infinity } },
      /Invalid value/,
    ],
    [
      { type: "tagText", name: "badge", children: [], attributes: { label: "two\nlines" } },
      /Invalid value/,
    ],
    [
      { type: "tagLeaf", name: "media", children: [{ type: "text", value: "lost label" }] },
      /cannot contain children/,
    ],
  ])("refuses unrepresentable AST %#", (node, message) => {
    // Invalid external input intentionally bypasses TypeScript's well-formed-node types.
    expect(() => write({ type: "root", children: [node] } as unknown as Root)).toThrow(message);
  });
});

// Tables add an escaping layer; ordinary phrasing contexts use the same writer.
test.each(["paragraph", "table", "link"] as const)(
  "round trips literal attributes in a %s",
  (context) => {
    for (const label of [
      "",
      'a "quote"',
      "tail\\",
      "\\|",
      "North|South",
      "[",
      "]",
      String.raw`\[\]`,
      "{% badge /%}",
      "%}",
      "café 🙂 &amp;",
    ]) {
      const node: TagTextNode = {
        type: "tagText",
        name: "badge",
        attributes: { label },
        children: [],
      };
      const tree: Root =
        context === "paragraph"
          ? document(node)
          : context === "link"
            ? {
                type: "root",
                children: [
                  {
                    type: "paragraph",
                    children: [{ type: "link", url: "/guide", title: null, children: [node] }],
                  },
                ],
              }
            : {
                type: "root",
                children: [
                  {
                    type: "table",
                    align: [null],
                    children: [
                      { type: "tableRow", children: [{ type: "tableCell", children: [node] }] },
                    ],
                  },
                ],
              };
      const output = write(tree);
      expect(meaning(parse(output)), `${context}: ${JSON.stringify(label)}`).toEqual(tree);
      expect(write(parse(output))).toBe(output);
    }
  },
);

test("keeps a list tight around nested block and inline tags", () => {
  const source = "- Before\n  {% panel %}\n  Hello {% badge /%}\n  {% /panel %}\n  After\n- Two";
  const tree = parse(source);
  expect(tree.children[0]).toMatchObject({
    type: "list",
    spread: false,
    children: [{ spread: false }, { spread: false }],
  });
  const output = write(tree);
  expect(meaning(parse(output))).toEqual(meaning(tree));
  expect(write(parse(output))).toBe(output);
});

test.each(["<div>content</div>", "<widget>\ncontent\n</widget>"])(
  "round trips a container ending in an HTML block: %s",
  (html) => {
    const source = `{% panel %}\n${html}\n\n{% /panel %}`;
    const tree = parse(source);
    expect(tree.children[0]).toMatchObject({
      type: "tagContainer",
      children: [{ type: "html", value: html }],
    });
    const output = write(tree);
    expect(meaning(parse(output))).toEqual(meaning(tree));
    expect(write(parse(output))).toBe(output);
  },
);

test.each([
  {
    name: "blank lines only inside a tag",
    source: "- {% panel %}\n\n  text\n\n  {% /panel %}\n- second",
    spread: false,
    itemSpread: false,
  },
  {
    name: "blank lines between paragraphs inside a tag",
    source: "- {% panel %}\n  first\n\n  second\n  {% /panel %}\n- second",
    spread: false,
    itemSpread: false,
  },
  {
    name: "blank lines before a tag",
    source: "- before\n\n  {% panel %}\n  text\n  {% /panel %}\n- second",
    spread: false,
    itemSpread: true,
  },
  {
    name: "blank lines after a tag",
    source: "- {% panel %}\n  text\n  {% /panel %}\n\n  after\n- second",
    spread: false,
    itemSpread: true,
  },
  {
    name: "blank lines between list items",
    source: "- {% panel %}\n\n  text\n\n  {% /panel %}\n\n- second",
    spread: true,
    itemSpread: false,
  },
])("derives list spacing from the grouped children: $name", ({ source, spread, itemSpread }) => {
  const tree = parse(source);
  expect(tree.children[0]).toMatchObject({
    type: "list",
    spread,
    children: [{ spread: itemSpread }, { spread: false }],
  });
  const output = write(tree);
  expect(meaning(parse(output))).toEqual(meaning(tree));
  expect(write(parse(output))).toBe(output);
});

import type { Root } from "mdast";
import { describe, expect, test } from "vite-plus/test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { tagFromMarkdown, tagSyntax, tagToMarkdown, TagSyntaxError } from "./index.js";
import { meaning } from "./test-support.js";

const declarations = {
  math: { kind: "inline" },
  badge: { kind: "inline" },
} as const;
const options = { expressions: true, escapedWhitespace: { math: ["text"] } };

function parse(source: string): Root {
  return fromMarkdown(source, {
    extensions: [tagSyntax(declarations, options)],
    mdastExtensions: [tagFromMarkdown(declarations, options)],
  });
}

function write(tree: Root): string {
  return toMarkdown(tree, { extensions: [tagToMarkdown(declarations, options)] });
}

describe("escaped whitespace with expressions", () => {
  test("retains admitted ordinary strings alongside variables and explicit templates", () => {
    const source = String.raw`{% math text="a\nb\rc\td\\n {% $literal %}" /%} {% $student.name %} {% badge label=t"Read {% $guide.title %}" /%}

{% template code %}
~~~sh
echo {% $package.name %}
~~~
{% /template code %}`;
    const tree = parse(source);
    expect(tree.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "tagText", name: "math", attributes: { text: "a\nb\rc\td\\n {% $literal %}" } },
        { type: "text", value: " " },
        { type: "tagVariable", path: "student.name" },
        { type: "text", value: " " },
        {
          type: "tagText",
          attributes: {
            label: {
              type: "topikTextTemplate",
              segments: [
                { type: "literal", value: "Read " },
                { type: "variable", path: ["guide", "title"] },
              ],
            },
          },
        },
      ],
    });
    expect(tree.children[1]).toMatchObject({ type: "tagCodeTemplate", lang: "sh" });
    const output = write(tree);
    expect(output).toContain(String.raw`text="a\nb\rc\td\\n {% $literal %}"`);
    expect(meaning(parse(output))).toEqual(meaning(tree));
    expect(write(parse(output))).toBe(output);
  });

  test("does not admit escaped whitespace in other slots or raw controls in the admitted slot", () => {
    for (const source of [
      String.raw`{% math title="a\nb" /%}`,
      String.raw`{% badge text="a\nb" /%}`,
      '{% math text="a\tb" /%}',
      '{% math text="a\u0007b" /%}',
    ])
      expect(() => parse(source)).toThrow(TagSyntaxError);

    expect(() =>
      write({
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "tagText", name: "math", attributes: { title: "a\nb" }, children: [] },
            ],
          },
        ],
      }),
    ).toThrow("Invalid value for attribute title");
  });

  test("keeps template literals control-free even in an admitted ordinary-string slot", () => {
    for (const escape of ["n", "r", "t"])
      expect(() => parse(`{% math text=t"a\\${escape}b" /%}`)).toThrow("Invalid escape in text");

    try {
      parse('{% math text=t"a\tb" /%}');
      throw new Error("Expected a template control diagnostic");
    } catch (error) {
      expect(error).toBeInstanceOf(TagSyntaxError);
      expect((error as TagSyntaxError).diagnostics).toContainEqual(
        expect.objectContaining({ id: "topik-template-control" }),
      );
    }

    expect(() =>
      write({
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "tagText",
                name: "math",
                attributes: {
                  text: {
                    type: "topikTextTemplate",
                    segments: [{ type: "literal", value: "a\nb" }],
                  },
                },
                children: [],
              },
            ],
          },
        ],
      }),
    ).toThrow("Invalid literal template text");
  });
});

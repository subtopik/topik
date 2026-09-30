import { describe, expect, test } from "vite-plus/test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import {
  TagSyntaxError,
  tagFromMarkdown,
  tagSyntax,
  tagToMarkdown,
  type TagDeclarations,
} from "./index.js";
import { meaning, parse, write } from "./test-support.js";

describe("tag grammar boundaries", () => {
  test.each([
    ["{% %}", "Invalid or unsupported tag"],
    ["{% Badge /%}", "Invalid or unsupported tag"],
    ["{% 9badge /%}", "Invalid or unsupported tag"],
    ["{% badge/%}", "Invalid attributes on badge"],
    ['{% badge @label="x" /%}', "Invalid attribute on badge"],
    ['{% badge __proto__="x" /%}', "Invalid attribute on badge"],
    ["{% badge label /%}", "Attribute label requires a value"],
    ['{% badge label ="x" /%}', "Attribute label requires a value"],
    ["{% badge label=plain /%}", "Attribute label must be quoted or a finite number/boolean"],
    ['{% badge label="x"label="y" /%}', "Invalid attributes on badge"],
    [String.raw`{% badge label="bad\q" /%}`, "Invalid escape in label"],
    [String.raw`{% badge label="bad\n" /%}`, "Invalid escape in label"],
    ['{% badge label="\u0007" /%}', "Control character in label"],
    ['{% badge label="\u007f" /%}', "Control character in label"],
    ['{% badge label="tab\tvalue" /%}', "Control character in label"],
    ['{% /badge label="x" %}', "Invalid closing tag badge"],
    ["{% /badge /%}", "Invalid closing tag badge"],
    ["{% /badge %}", "Mismatched closing tag badge"],
    ["{% constructor /%}", "Unknown tag constructor"],
    ["{% hint %}open", "Unclosed tag hint"],
    ["**Before {% hint %}inside** outside {% /hint %}", "Unclosed tag hint"],
    ['{% badge label="two\nlines" /%}', "Unterminated tag"],
    ["{%", "Unterminated tag"],
    ['{% badge label="never closes %}', "Unterminated attribute label"],
    ["{% panel /%} trailing", "Block tag panel is not valid here"],
    ["{% hint %}paragraph\n\nnext{% /hint %}", "Unclosed tag hint"],
  ])("refuses %s with a specific diagnostic", (source, message) => {
    expect(() => parse(source)).toThrow(message);
  });

  test("preserves camelCase names and distinct literal scalar types", () => {
    const declarations = { cardGrid: { kind: "block" } } as const;
    const source = '{% cardGrid columns=3 open=true darkSrc="3" %}\nBody.\n{% /cardGrid %}';
    const document = fromMarkdown(source, {
      extensions: [tagSyntax(declarations)],
      mdastExtensions: [tagFromMarkdown(declarations)],
    });
    expect(document.children[0]).toMatchObject({
      type: "tagContainer",
      name: "cardGrid",
      attributes: { columns: 3, open: true, darkSrc: "3" },
    });
    const written = toMarkdown(document, { extensions: [tagToMarkdown(declarations)] });
    expect(written).toContain('columns=3 darkSrc="3" open=true');
    expect(
      toMarkdown(
        fromMarkdown(written, {
          extensions: [tagSyntax(declarations)],
          mdastExtensions: [tagFromMarkdown(declarations)],
        }),
        { extensions: [tagToMarkdown(declarations)] },
      ),
    ).toBe(written);
  });

  test.each(["\n", "\r\n", "\r"])("normalizes %j line endings around block tags", (eol) => {
    const source = ["{% panel %}", "A {% badge /%} check.", "{% /panel %}", ""].join(eol);
    const expected = "{% panel %}\nA {% badge /%} check.\n{% /panel %}\n";
    expect(write(parse(source))).toBe(expected);
    expect(meaning(parse(source))).toEqual(meaning(parse(expected)));
  });

  test.each([
    ['{%\tbadge\tlabel="x"\t/%}', '{% badge label="x" /%}\n'],
    ["{%\tpanel\t%}\t\nBody\n{%\t/panel\t%}\t", "{% panel %}\nBody\n{% /panel %}\n"],
  ])("normalizes horizontal whitespace: %s", (source, expected) => {
    expect(write(parse(source))).toBe(expected);
  });

  test("keeps ordinary braces, indented code, HTML, and code spans literal", () => {
    const source =
      "{ordinary} and {%bad\n\n    {% unknown /%}\n\n<div>\n{% unknown /%}\n</div>\n\n``{% unknown /%}``";
    // A real unescaped opener is still an error, even next to literal contexts.
    expect(() => parse(source)).toThrow(TagSyntaxError);
    const literal = source.replace("{%bad", "{ordinary-again}");
    expect(meaning(parse(write(parse(literal))))).toEqual(meaning(parse(literal)));
    expect(parse(literal).children.map((node) => node.type)).toEqual([
      "paragraph",
      "code",
      "html",
      "paragraph",
    ]);
  });

  test("retains exact spans for nested tags after CRLF and an astral character", () => {
    const source = "First\r\n🙂 {% hint %}x{% badge /%}{% /hint %}";
    const root = parse(source);
    expect(root.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "First\r\n🙂 " },
        {
          type: "tagText",
          position: {
            start: { line: 2, column: 4, offset: 10 },
            end: { line: 2, column: 38, offset: 44 },
          },
          children: [
            { type: "text", value: "x" },
            {
              type: "tagText",
              position: {
                start: { line: 2, column: 15, offset: 21 },
                end: { line: 2, column: 27, offset: 33 },
              },
            },
          ],
        },
      ],
    });
  });

  test.each([tagSyntax, tagFromMarkdown, tagToMarkdown])(
    "validates declarations at every entry point %#",
    (extension) => {
      for (const declarations of [
        { Bad: { kind: "inline" } },
        { bad_name: { kind: "inline" } },
        { badge: { kind: "other" } },
        { badge: null },
      ])
        expect(() => extension(declarations as unknown as TagDeclarations)).toThrow();
    },
  );

  test("does not accept inherited declaration names", () => {
    const tags = Object.create({ badge: { kind: "inline" } }) as TagDeclarations;
    expect(() => parse("{% badge /%}", tags)).toThrow("Unknown tag badge");
  });
});

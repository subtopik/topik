import { describe, expect, test } from "vite-plus/test";
import { meaning } from "./test-support.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { tagFromMarkdown, tagSyntax, tagToMarkdown, TagSyntaxError } from "./index.js";

const options = { expressions: true };
const declarations = { badge: { kind: "inline" }, panel: { kind: "block" } } as const;

function parse(source: string) {
  return fromMarkdown(source, {
    extensions: [tagSyntax(declarations, options)],
    mdastExtensions: [tagFromMarkdown(declarations, options)],
  });
}

function write(source: string): string {
  return toMarkdown(parse(source), { extensions: [tagToMarkdown(declarations, options)] });
}

describe("opt-in expression tags", () => {
  test("retains an inline variable and both nested conditional branches", () => {
    const source =
      'Hello {% $student.name %}.\n\n{% if equals($student.role, "mentor") %}\n\nMentor.\n\n{% if $course.hasExercises %}\n\nExercises.\n\n{% else /%}\n\nNo exercises.\n\n{% /if %}\n\n{% else /%}\n\nStudent.\n\n{% /if %}';
    const document = parse(source);
    expect(document.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text" }, { type: "tagVariable", path: "student.name" }, { type: "text" }],
    });
    expect(document.children[1]).toMatchObject({
      type: "tagConditional",
      children: [
        {
          type: "tagBranch",
          condition: 'equals($student.role, "mentor")',
          children: [
            { type: "paragraph" },
            {
              type: "tagConditional",
              children: [{ type: "tagBranch" }, { type: "tagBranch", condition: null }],
            },
          ],
        },
        { type: "tagBranch", condition: null, children: [{ type: "paragraph" }] },
      ],
    });
    const canonical = write(source);
    expect(meaning(parse(canonical))).toEqual(meaning(document));
    expect(write(canonical)).toBe(canonical);
  });

  test("quoted percent-close stays inside an expression; escaped and code lookalikes stay literal", () => {
    const source =
      String.raw`\{% $student.name %}` +
      ' and `{% $student.name %}`\n\n{% if equals($course.marker, "%}") %}\n\nYes.\n\n{% /if %}';
    expect(parse(source).children).toMatchObject([
      { type: "paragraph" },
      { type: "tagConditional", children: [{ condition: 'equals($course.marker, "%}")' }] },
    ]);
    expect(write(write(source))).toBe(write(source));
  });

  test("normalizes else whitespace and refuses unquoted delimiters in constructed conditions", () => {
    const source = "{% if $flag %}\n\nYes.\n\n{% else   /%}\n\nNo.\n\n{% /if %}";
    expect(write(source)).toContain("{% else /%}");
    const document = parse(source);
    const conditional = document.children[0] as unknown as {
      children: Array<{ condition: string | null }>;
    };
    conditional.children[0].condition = "$flag %} {% else /%}";
    expect(() =>
      toMarkdown(document, { extensions: [tagToMarkdown(declarations, options)] }),
    ).toThrow(/Invalid conditional branches/);
  });

  test("declared hyphenated names beginning with if or else remain ordinary tags", () => {
    const names = {
      ...declarations,
      "if-note": { kind: "block" },
      "else-note": { kind: "block" },
    } as const;
    const source =
      "{% if-note %}\n\nFirst.\n\n{% /if-note %}\n\n{% else-note %}\n\nSecond.\n\n{% /else-note %}";
    const document = fromMarkdown(source, {
      extensions: [tagSyntax(names, options)],
      mdastExtensions: [tagFromMarkdown(names, options)],
    });
    expect(document.children).toMatchObject([
      { type: "tagContainer", name: "if-note" },
      { type: "tagContainer", name: "else-note" },
    ]);
    const written = toMarkdown(document, { extensions: [tagToMarkdown(names, options)] });
    expect(written).toContain("{% /if-note %}");
    expect(written).toContain("{% /else-note %}");
  });

  test.each([
    "{% else /%}",
    "{% if $flag %}\n\nYes.\n\n{% else /%}\n\nNo.\n\n{% else /%}\n\nAgain.\n\n{% /if %}",
    "{% if $flag %}\n\nYes.\n\n{% else if $other /%}\n\nNo.\n\n{% /if %}",
  ])("refuses malformed branch structure: %s", (source) => {
    expect(() => parse(source)).toThrow(TagSyntaxError);
  });

  test.each([
    "{% if $flag %}\n<div>first</div>\n\n{% /if %}",
    "{% if $flag %}\n<div>first</div>\n\n{% else /%}\nSecond.\n{% /if %}",
    "{% if $flag %}\nFirst.\n{% else /%}\n<widget>\nsecond\n</widget>\n\n{% /if %}",
  ])("round trips an HTML block at a branch boundary: %s", (source) => {
    const tree = parse(source);
    const output = write(source);
    expect(meaning(parse(output))).toEqual(meaning(tree));
    expect(write(output)).toBe(output);
  });

  test("keeps a list tight when blank lines are inside conditional branches", () => {
    const source =
      "- {% if $flag %}\n\n  First.\n\n  {% else /%}\n\n  Second.\n\n  {% /if %}\n- next";
    const tree = parse(source);
    expect(tree.children[0]).toMatchObject({
      type: "list",
      spread: false,
      children: [{ spread: false }, { spread: false }],
    });
    const output = write(source);
    expect(meaning(parse(output))).toEqual(meaning(tree));
    expect(write(output)).toBe(output);
  });

  describe.each(["\n", "\r\n"])("branch source ranges with %j line endings", (eol) => {
    test.each([
      ["First.", "Second."],
      ["", "Second."],
      ["First.", ""],
      ["", ""],
    ])("covers populated and empty branches (%j, %j)", (first, second) => {
      const opening = "{% if $flag %}";
      const alternate = "{% else /%}";
      const closing = "{% /if %}";
      const source = [opening, "", first, "", alternate, "", second, "", closing].join(eol);
      const conditional = parse(source).children[0];
      expect(conditional).toMatchObject({
        type: "tagConditional",
        position: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 9, column: closing.length + 1, offset: source.length },
        },
        children: [
          {
            type: "tagBranch",
            position: {
              start: { line: 1, column: 1, offset: 0 },
              end: first
                ? {
                    line: 3,
                    column: first.length + 1,
                    offset: source.indexOf(first) + first.length,
                  }
                : { line: 1, column: opening.length + 1, offset: opening.length },
            },
          },
          {
            type: "tagBranch",
            position: {
              start: { line: 5, column: 1, offset: source.indexOf(alternate) },
              end: second
                ? {
                    line: 7,
                    column: second.length + 1,
                    offset: source.indexOf(second) + second.length,
                  }
                : {
                    line: 5,
                    column: alternate.length + 1,
                    offset: source.indexOf(alternate) + alternate.length,
                  },
            },
          },
        ],
      });
    });
  });
});

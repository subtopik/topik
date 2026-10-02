import { describe, expect, test } from "vite-plus/test";
import { parseExpression, writeExpression } from "./expressions.js";
import {
  ContentEvaluationError,
  evaluateDocument,
  mergeTopikContentConfig,
  parseDocument,
  transformTopikContent,
  writeDocument,
} from "./index.js";
import { parse, withoutPositions } from "./test-helpers.js";

describe("bounded expressions", () => {
  test("canonical strings and negative zero retain exact literal meaning", () => {
    for (const value of ["\0", "\b", "\f", "both ' and \"", "line\nnext", -0]) {
      const expression = { type: "literal", value } as const;
      expect(parseExpression(writeExpression(expression))).toEqual(expression);
    }
    expect(
      Object.is(
        (parseExpression(writeExpression({ type: "literal", value: -0 })) as { value: number })
          .value,
        -0,
      ),
    ).toBe(true);
  });

  test("parses nested calls and refuses functions or arity outside the subset", () => {
    expect(parseExpression('and(equals($student.role, "mentor"), not(false))')).toMatchObject({
      type: "call",
      name: "and",
      args: [
        { type: "call", name: "equals" },
        { type: "call", name: "not" },
      ],
    });
    for (const source of [
      "fetch($x)",
      "and($x)",
      "not($x, true)",
      "1e999",
      "$a.__proto__",
      "true + false",
    ])
      expect(() => parseExpression(source)).toThrow();
  });
});

describe("evaluation boundary", () => {
  test("uses Markdoc truthiness, strict scalar equality, and lazy branches", () => {
    const document = parse(
      "{% if and($zero, or($empty, $missing)) %}\n\nTrue.\n\n{% else /%}\n\nFalse.\n\n{% /if %}",
    );
    expect(writeDocument(evaluateDocument(document, { zero: 0, empty: "" }))).toBe("True.\n");
    expect(
      writeDocument(
        evaluateDocument(
          parse('{% if equals("1", 1) %}\n\nWrong.\n\n{% else /%}\n\nRight.\n\n{% /if %}'),
          {},
        ),
      ),
    ).toBe("Right.\n");
    expect(
      writeDocument(
        evaluateDocument(
          parse("{% if and(false, $missing) %}\n\nWrong.\n\n{% else /%}\n\nRight.\n\n{% /if %}"),
          {},
        ),
      ),
    ).toBe("Right.\n");
    expect(() => evaluateDocument(parse("{% if $missing %}\n\nX.\n\n{% /if %}"), {})).toThrow(
      ContentEvaluationError,
    );
    for (const condition of [
      "equals(and(1, 2), true)",
      'equals(or(false, "yes"), true)',
      "equals(0, -0)",
    ])
      expect(
        writeDocument(
          evaluateDocument(
            parse(`{% if ${condition} %}\n\nYes.\n\n{% else /%}\n\nNo.\n\n{% /if %}`),
            {},
          ),
        ),
      ).toBe("Yes.\n");
    expect(() =>
      evaluateDocument(parse("{% if equals($object, $object) %}\n\nX.\n\n{% /if %}"), {
        object: {},
      }),
    ).toThrow(/scalar/);
  });

  test("interpolates as text, drops empty-only paragraphs, and never mutates authorship", () => {
    const document = parse("{% $value %}\n\nValue: {% $markdown %}.");
    const original = withoutPositions(structuredClone(document));
    const resolved = evaluateDocument(document, { value: null, markdown: "**literal**" });
    expect(writeDocument(resolved)).toBe("Value: \\*\\*literal\\*\\*.\n");
    expect(withoutPositions(document)).toEqual(original);
    expect(writeDocument(document)).toContain("{% $value %}");
    for (const value of ["A\n\nB", "A\tB", "A\0B"])
      expect(() => evaluateDocument(parse("Value: {% $value %}."), { value })).toThrow(
        /single-line/,
      );
    const callout = parse('{% callout title="Original" %}\n\n{% $value %}\n\n{% /callout %}');
    const evaluated = evaluateDocument(callout, { value: "Resolved" });
    const resolvedCallout = evaluated.children[0];
    const authoredCallout = callout.children[0];
    if (resolvedCallout.type !== "topikComponent" || authoredCallout.type !== "topikComponent")
      throw new Error("Expected callout components");
    resolvedCallout.props.title = "Changed";
    expect(authoredCallout.props.title).toBe("Original");
  });

  test("removes empty marks without changing surrounding prose", () => {
    for (const source of [
      "**{% $value %}**",
      "*{% $value %}*",
      "~~{% $value %}~~",
      "Text **{% $value %}** end.",
      "Text ***{% $value %}*** end.",
    ]) {
      const authored = parse(source);
      const resolved = evaluateDocument(authored, { value: "" });
      const written = writeDocument(resolved);
      expect(withoutPositions(parse(written))).toEqual(withoutPositions(resolved));
      expect(writeDocument(authored)).toContain("{% $value %}");
    }
    expect(
      writeDocument(evaluateDocument(parse("Text **{% $value %}** end."), { value: null })),
    ).toBe("Text  end.\n");
  });

  test.each([null, ""])("normalizes empty interpolation consistently: %j", (value) => {
    const config = {
      components: {
        tooltip: {
          kind: "inline" as const,
          render: "Tooltip",
          attributes: {},
          children: "inline" as const,
        },
      },
      variables: { value },
    };
    const registry = mergeTopikContentConfig(config).components;
    for (const [source, expected] of [
      ["{% badge %}{% $value %}{% /badge %}", ""],
      ["{% underline %}{% $value %}{% /underline %}", ""],
      ["{% u %}{% $value %}{% /u %}", ""],
      ["{% tooltip %}**{% $value %}**{% /tooltip %}", ""],
      ["Before {% badge %}**{% $value %}**{% /badge %} after.", "Before  after.\n"],
      ["Before  \n{% $value %}", "Before\n"],
      ["Before  \n{% badge %}{% $value %}{% /badge %}", "Before\n"],
    ]) {
      const document = parse(source, registry);
      const original = structuredClone(document);
      const resolved = evaluateDocument(document, { value }, registry);
      expect(writeDocument(resolved, registry)).toBe(expected);
      expect(transformTopikContent(document, config)).toEqual(
        transformTopikContent(parse(expected), config),
      );
      expect(document).toEqual(original);
    }
  });

  test("retains nonempty inline components, interior breaks, and self-closing content", () => {
    const source = 'Before  \n{% badge %}{% $value %}{% /badge %} {% mathInline content="x" /%}';
    const resolved = evaluateDocument(parse(source), { value: "Ready" });
    expect(writeDocument(resolved)).toBe(
      'Before\\\n{% badge %}Ready{% /badge %} {% mathInline content="x" /%}\n',
    );
    expect(transformTopikContent(resolved)).toMatchObject({
      children: [
        {
          children: [
            "Before",
            { name: "br" },
            { name: "TopikBadge" },
            " ",
            { name: "TopikMathInline" },
          ],
        },
      ],
    });
  });

  test.each([true, false])(
    "refuses an unwritable empty task item without losing its checked=%s state in rendering",
    (checked) => {
      const document = parse(`- [${checked ? "x" : " "}] {% $value %}`);
      const original = structuredClone(document);
      for (const value of [null, ""]) {
        expect(() => evaluateDocument(document, { value })).toThrow(ContentEvaluationError);
        expect(transformTopikContent(document, { variables: { value } })).toMatchObject({
          children: [
            {
              name: "ul",
              children: [
                {
                  name: "li",
                  children: [{ name: "input", attributes: { type: "checkbox", checked } }],
                },
              ],
            },
          ],
        });
      }
      expect(writeDocument(evaluateDocument(document, { value: "Task" }))).toBe(
        `- [${checked ? "x" : " "}] Task\n`,
      );
      expect(document).toEqual(original);
    },
  );

  test("refuses unwritable adjacent marks without merging their rendered boundaries", () => {
    const document = parse("~~a~~{% $value %}~~b~~");
    const original = structuredClone(document);
    for (const value of [null, ""]) {
      expect(() => evaluateDocument(document, { value })).toThrow(ContentEvaluationError);
      expect(transformTopikContent(document, { variables: { value } })).toMatchObject({
        children: [
          {
            children: [
              { name: "s", children: ["a"] },
              { name: "s", children: ["b"] },
            ],
          },
        ],
      });
    }
    expect(writeDocument(evaluateDocument(document, { value: " and " }))).toBe("~~a~~ and ~~b~~\n");
    expect(document).toEqual(original);
  });

  test("writes significant boundary whitespace in strikethrough and tables", () => {
    const strike = parse("~~{% $value %}~~");
    const table = parse("| Value |\n| --- |\n| {% $value %} |");
    for (const value of [" ", " a ", "\u2028"]) {
      const resolved = evaluateDocument(strike, { value });
      const written = writeDocument(resolved);
      expect(written).toContain("&#x");
      expect(withoutPositions(parse(written))).toEqual(withoutPositions(resolved));
      expect(writeDocument(strike)).toContain("{% $value %}");
    }
    for (const value of [" ", " a "]) {
      const resolved = evaluateDocument(table, { value });
      const written = writeDocument(resolved);
      expect(written).toContain("&#x20;");
      expect(withoutPositions(parse(written))).toEqual(withoutPositions(resolved));
      expect(writeDocument(table)).toContain("{% $value %}");
    }
    const safe = evaluateDocument(parse("~~A {% $value %} Z~~"), { value: "a b" });
    const written = writeDocument(safe);
    expect(withoutPositions(parse(written))).toEqual(withoutPositions(safe));
  });

  test("rejects prototype paths, object interpolation, and references outside their scope", () => {
    const unsafe = "A {% $student.__proto__ %}.";
    expect(parseDocument(unsafe)).toMatchObject({ ok: false, source: unsafe });
    expect(() => evaluateDocument(parse("{% $student %}"), { student: { name: "Ari" } })).toThrow(
      ContentEvaluationError,
    );
    const source = "[Read][ref]\n\n{% if $show %}\n\n[ref]: https://example.test\n\n{% /if %}";
    expect(parseDocument(source)).toMatchObject({
      ok: false,
      source,
      diagnostics: [expect.objectContaining({ id: "topik-reference-missing" })],
    });
  });

  test("validates inactive branches and refuses ambiguous constrained containers", () => {
    const invalid =
      "{% if true %}\n\nYes.\n\n{% else /%}\n\n{% if unknown(true) %}\n\nNo.\n\n{% /if %}\n\n{% /if %}";
    expect(parseDocument(invalid)).toMatchObject({ ok: false, source: invalid });
    const tabs =
      '{% tabs %}\n\n{% if true %}\n\n{% tab label="A" %}\n\nA.\n\n{% /tab %}\n\n{% /if %}\n\n{% /tabs %}';
    expect(parseDocument(tabs)).toMatchObject({ ok: false, source: tabs });
  });
});

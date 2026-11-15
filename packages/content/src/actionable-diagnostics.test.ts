import { describe, expect, test } from "vite-plus/test";
import {
  compileTopikContent,
  ContentEvaluationError,
  evaluateDocument,
  mergeTopikContentConfig,
  sanitizeTopikContentDiagnostic,
  validateDocument,
  validateTopikContent,
  type ContentDocument,
  type TopikContentConfig,
} from "./index.js";
import { parse } from "./test-helpers.js";

function compileDiagnostics(source: string, config?: TopikContentConfig) {
  const result = compileTopikContent(source, { config });
  expect(result.ok).toBe(false);
  return result.diagnostics;
}

describe("body and condition variables", () => {
  test.each([
    ["Hello {% $nmae %}", { name: "x" }, "topikVariable", 1, "nmae", "topik-variable-missing"],
    [
      "Intro\n\n{% if $flag %}\nA\n{% /if %}",
      {},
      "topikConditional",
      3,
      "flag",
      "topik-variable-missing",
    ],
    [
      '{% if equals($user.role, "admin") %}\nA\n{% /if %}',
      { user: {} },
      "topikConditional",
      1,
      "user.role",
      "topik-variable-missing",
    ],
    [
      "A\n\nHello {% $obj %}",
      { obj: { secret: "PRIVATE_VALUE" } },
      "topikVariable",
      3,
      "obj",
      "topik-variable-type",
    ],
    [
      "Hello {% $name.first %}",
      { name: "PRIVATE_VALUE" },
      "topikVariable",
      1,
      "name.first",
      "topik-variable-type",
    ],
    [
      "Hello {% $name %}",
      { name: "line\nPRIVATE_VALUE" },
      "topikVariable",
      1,
      "name",
      "topik-variable-control",
    ],
  ])(
    "%s reports a located diagnostic with the variable path",
    (source, variables, type, line, variable, id) => {
      const diagnostics = compileDiagnostics(source, { variables });
      expect(diagnostics).toEqual([
        expect.objectContaining({ id, type, level: "error", lines: [line], variable }),
      ]);
      expect(diagnostics[0].message).not.toBe("Content transformation failed.");
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_VALUE");
    },
  );

  test("condition comparisons of non-scalar values are located", () => {
    expect(
      compileDiagnostics('{% if equals($user, "x") %}\nA\n{% /if %}', { variables: { user: {} } }),
    ).toEqual([expect.objectContaining({ id: "topik-expression-type", lines: [1] })]);
  });

  test("direct evaluation still throws ContentEvaluationError with a developer message", () => {
    const document = parse("Hello {% $nmae %}");
    expect(() => evaluateDocument(document, { name: "x" })).toThrow(ContentEvaluationError);
    expect(() => evaluateDocument(document, { name: "x" })).toThrow("Missing variable $nmae");
  });

  test("unsafe authored paths are not copied into the variable field", () => {
    expect(
      sanitizeTopikContentDiagnostic({
        id: "topik-variable-missing",
        type: "topikVariable",
        level: "error",
        message: "PRIVATE_VALUE",
        lines: [1],
        variable: "a b",
      }),
    ).not.toHaveProperty("variable");
  });
});

describe("tag syntax diagnostics", () => {
  test.each([
    ["{% callout %}\n\nText", [["missing-closing", 1]]],
    ["Text\n\n{% /callout %}", [["missing-opening", 3]]],
    [
      "{% callout %}\nText\n{% /tabs %}",
      [
        ["missing-opening", 3],
        ["missing-closing", 1],
      ],
    ],
    ["{% callout", [["tag-unterminated", 1]]],
    ['{% badge text="a" text="b" /%}', [["duplicate-attribute", 1]]],
    ["{% badge text=plain /%}", [["attribute-syntax-invalid", 1]]],
    ['{% /callout title="x" %}', [["tag-closing-invalid", 1]]],
    ["{% Callout /%}", [["tag-name-invalid", 1]]],
    ["Text {% callout %} more", [["tag-placement-invalid", 1]]],
    ["{% else /%}", [["topik-else-placement", 1]]],
    ["{% if $a %}\nA\n{% else %}\nB\n{% /if %}", [["topik-else-syntax", 3]]],
    ["{% unknown /%}", [["tag-undefined", 1]]],
  ])("%s reports specific IDs", (source, expected) => {
    const diagnostics = compileDiagnostics(source);
    expect(diagnostics.map(({ id, lines }) => [id, lines[0]])).toEqual(expected);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.message).not.toBe("Content could not be parsed.");
      expect(diagnostic.level).toBe("critical");
    }
  });

  test("unknown-tag classification uses the ID rather than message wording", () => {
    // A component whose name begins like the old prefix is still an ordinary tag.
    const result = validateTopikContent("{% unknown /%}");
    expect(result.errors).toEqual([expect.objectContaining({ id: "tag-undefined", lines: [1] })]);
  });

  test("an unsupported expression is reported once", () => {
    expect(compileDiagnostics("{% if $a == 1 %}\nx\n{% /if %}")).toEqual([
      expect.objectContaining({ id: "topik-expression-invalid", lines: [1] }),
    ]);
  });
});

describe("unsupported Markdown nodes", () => {
  test.each([
    ["Paragraph\n\n<!-- note -->", "html", 3],
    ["<div>x</div>", "html", 1],
    ["> Quote\n>\n> <aside>x</aside>", "html", 3],
    ["{% callout %}\n<div>x</div>\n\n{% /callout %}", "html", 2],
    ["{% if $a %}\n<div>x</div>\n\n{% /if %}", "html", 2],
  ])("%s reports node-undefined at the node", (source, type, line) => {
    expect(validateTopikContent(source).errors).toEqual([
      expect.objectContaining({ id: "node-undefined", type, lines: [line] }),
    ]);
  });

  test("inline HTML reports its line once, at the first column", () => {
    expect(validateTopikContent("Text <b>bold</b>").errors).toEqual([
      expect.objectContaining({ id: "node-undefined", type: "html", lines: [1], column: 6 }),
    ]);
  });

  test("footnotes report each unsupported node", () => {
    expect(validateTopikContent("Text[^1]\n\n[^1]: Note").errors).toEqual([
      expect.objectContaining({ id: "node-undefined", type: "footnoteReference", lines: [1] }),
      expect.objectContaining({ id: "node-undefined", type: "footnoteDefinition", lines: [3] }),
    ]);
  });

  test("a heading ID that does not end its heading has a placement diagnostic", () => {
    expect(validateTopikContent("# A {% #x %} B").errors).toEqual([
      expect.objectContaining({ id: "topik-heading-id-placement", lines: [1] }),
    ]);
  });

  test("caller-built unsupported nodes keep shape checks and bounded types", () => {
    const valid = {
      type: "root",
      children: [
        {
          type: "html",
          value: "<b>",
          position: { start: { line: 4, column: 1 }, end: { line: 4, column: 4 } },
        },
      ],
    } as unknown as ContentDocument;
    expect(validateDocument(valid)).toEqual([
      expect.objectContaining({ id: "node-undefined", type: "html", line: 4 }),
    ]);
    const malformed = {
      type: "root",
      children: [{ type: "html", position: { start: { line: 0 } } }],
    } as unknown as ContentDocument;
    expect(validateDocument(malformed)).toEqual([
      expect.objectContaining({ id: "topik-node-invalid" }),
    ]);
    const odd = { type: "root", children: [{ type: "x y" }] } as unknown as ContentDocument;
    expect(validateDocument(odd)[0]).not.toHaveProperty("type");
  });
});

describe("custom component diagnostics", () => {
  const config: TopikContentConfig = {
    components: {
      gallery: {
        kind: "block",
        render: "Gallery",
        attributes: { columns: { type: "number", min: 1, max: 4 } },
        children: { components: ["slide"], min: 1 },
      },
      slide: {
        kind: "block",
        render: "Slide",
        attributes: {},
        children: "blocks",
        allowedParents: ["gallery"],
      },
    },
  };

  test.each([
    [
      "{% gallery columns=9 %}\n{% slide %}\nA\n{% /slide %}\n{% /gallery %}",
      "topik-columns-range",
    ],
    ["{% gallery %}\nText\n{% /gallery %}", "topik-gallery-children"],
    ["{% gallery %}\n{% /gallery %}", "topik-gallery-requires-slide"],
    ["{% slide %}\nA\n{% /slide %}", "topik-gallery-parent-required"],
  ])("%s has a meaningful fixed message", (source, id) => {
    const result = validateTopikContent(source, { config });
    const diagnostic = result.errors.find((item) => item.id === id);
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.message).not.toBe("Content validation failed.");
  });

  test("unknown IDs still use the generic fixed message", () => {
    expect(
      sanitizeTopikContentDiagnostic({
        id: "Topik Private-children",
        type: "document",
        level: "error",
        message: "PRIVATE_VALUE",
        lines: [],
      }).message,
    ).toBe("Content validation failed.");
  });
});

describe("configuration errors", () => {
  const base = { kind: "block", render: "Notice", attributes: {}, children: "blocks" } as const;

  test.each([
    [{ bogus: 1 }, 'unsupported field "bogus"'],
    [{ components: { Notice: base } }, 'component "Notice" has an invalid name'],
    [{ components: { if: base } }, 'component "if" uses a reserved name'],
    [{ components: { notice: { ...base, kind: "wide" } } }, 'component "notice" kind must be'],
    [
      { components: { notice: { ...base, attributes: { tone: { type: "color" } } } } },
      'component "notice" attribute "tone" type must be',
    ],
    [
      {
        components: {
          notice: { ...base, attributes: { size: { type: "number", min: 3, max: 1 } } },
        },
      },
      'component "notice" attribute "size" min must not exceed max',
    ],
    [
      { components: { notice: { ...base, allowedParents: ["tabz"] } } },
      'component "notice" allowedParents names unknown component "tabz"',
    ],
    [
      { components: { notice: { ...base, children: { components: ["missing"] } } } },
      'component "notice" children.components names unknown component "missing"',
    ],
    [
      { variables: { when: new Date(0) } },
      "variables.when must contain only arrays and plain objects",
    ],
  ])("names the invalid field: %j", (config, detail) => {
    expect(() => mergeTopikContentConfig(config as never)).toThrow(
      `Content configuration is invalid: ${detail}`,
    );
  });

  test("component references may name canonical or other custom components", () => {
    expect(() =>
      mergeTopikContentConfig({
        components: {
          slide: { ...base, allowedParents: ["gallery", "tabs"] },
          gallery: { ...base, children: { components: ["slide", "card"] } },
        },
      }),
    ).not.toThrow();
  });

  test("wrapped limit failures keep their cause", () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 10_000; index++) nested = { next: nested };
    let thrown: unknown;
    try {
      mergeTopikContentConfig({ variables: nested });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Content configuration is invalid");
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  test("source APIs still report the fixed configuration diagnostic", () => {
    expect(
      compileDiagnostics("Hello", {
        components: { notice: { ...base, allowedParents: ["tabz"] } },
      }),
    ).toEqual([
      expect.objectContaining({
        id: "topik-config-invalid",
        message: "Content configuration is invalid.",
      }),
    ]);
  });
});

import { describe, expect, test, vi } from "vite-plus/test";
import {
  compileTopikContent,
  evaluateDocument,
  formatDocument,
  mergeTopikContentConfig,
  parseDocument,
  validateDocument,
  writeDocument,
  type ContentDocument,
} from "./index.js";
import { parse, withoutPositions } from "./test-helpers.js";

const open = "{% template code %}";
const close = "{% /template code %}";
const fence = (payload: string, delimiter = "```", header = "text") =>
  `${delimiter}${header}\n${payload}\n${delimiter}`;
const code = (payload: string, delimiter = "```", header = "text") =>
  `${open}\n${fence(payload, delimiter, header)}\n${close}`;
const title = (payload: string) => `{% callout title=t"${payload}" %}\nBody.\n{% /callout %}`;
const root = (node: unknown) => ({ type: "root", children: [node] }) as ContentDocument;
const authoredCode = (segments: unknown) => ({
  type: "topikCodeTemplate",
  lang: "text",
  meta: null,
  template: { type: "topikTextTemplate", segments },
});

function nodes(document: ContentDocument): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  function visit(node: Record<string, unknown>): void {
    result.push(node);
    if (Array.isArray(node.children))
      for (const child of node.children) visit(child as Record<string, unknown>);
  }
  visit(document as unknown as Record<string, unknown>);
  return result;
}

describe("paired code-template boundaries", () => {
  test.each([
    ["root", (body: string) => body],
    ["list item", (body: string) => `- ${body.replaceAll("\n", "\n  ")}\n- Next.`],
    [
      "blockquote",
      (body: string) =>
        body
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
    ],
    ["component", (body: string) => `{% callout %}\n${body}\n{% /callout %}`],
    ["conditional branch", (body: string) => `{% if $show %}\n${body}\n{% /if %}`],
    [
      "code tab",
      (body: string) =>
        `{% codeGroup %}\n{% codeTab title="Example" %}\n${body}\n{% /codeTab %}\n{% /codeGroup %}`,
    ],
  ] as const)("bounds interpolation before a later literal fence in a %s", (_name, wrap) => {
    const source = wrap(`${code("{% $name %}")}\n\n${fence("{% $missing %}")}`);
    const document = parse(source);
    expect(nodes(document).filter((node) => node.type === "topikCodeTemplate")).toHaveLength(1);
    expect(nodes(document).filter((node) => node.type === "code")).toMatchObject([
      { value: "{% $missing %}" },
    ]);
    const reader = evaluateDocument(document, { show: true, name: "Example" });
    expect(nodes(reader).filter((node) => node.type === "code")).toMatchObject([
      { value: "Example" },
      { value: "{% $missing %}" },
    ]);
    const written = writeDocument(document);
    expect(writeDocument(parse(written))).toBe(written);
  });

  test.each([
    ["missing fence", `${open}\n${close}\n\n${fence("later")}`],
    ["missing close", `${open}\n${fence("example")}`],
    ["missing fence terminator", `${open}\n\`\`\`text\nexample\n${close}`],
    ["wrong fence terminator", `${open}\n\`\`\`text\nexample\n~~~\n${close}`],
    ["multiple fences", `${open}\n${fence("a")}\n${fence("b")}\n${close}`],
    ["intervening prose", `${open}\nBefore.\n${fence("a")}\n${close}`],
    ["indented code", `${open}\n\n    example\n\n${close}`],
    ["nested scope", `${open}\n${code("example")}\n${close}`],
    [
      "cross-list-item scope",
      `- ${open}\n  ${fence("example").replaceAll("\n", "\n  ")}\n- ${close}`,
    ],
    ["cross-quote scope", `> ${open}\n> ${fence("example").replaceAll("\n", "\n> ")}\n\n${close}`],
    [
      "cross-component scope",
      `{% callout %}\n${open}\n${fence("example")}\n{% /callout %}\n${close}`,
    ],
    [
      "component-wrapped fence",
      `${open}\n{% callout %}\n${fence("example")}\n{% /callout %}\n${close}`,
    ],
    [
      "cross-branch scope",
      `{% if $show %}\n${open}\n${fence("example")}\n{% else /%}\n${close}\n{% /if %}`,
    ],
    [
      "scope around conditional",
      `${open}\n{% if $show %}\n${fence("example")}\n{% /if %}\n${close}`,
    ],
    ["open attributes", `{% template code label="example" %}\n${fence("example")}\n${close}`],
    ["close attributes", `${open}\n${fence("example")}\n{% /template code label="example" %}`],
    ["self-closing marker", `{% template code /%}\n${fence("example")}`],
  ])("refuses %s without formatting partial output", (_name, source) => {
    const result = formatDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("document");
    expect(result).not.toHaveProperty("formatted");
  });

  test.each(["```", "~~~"])(
    "keeps an explicitly closed empty %s fence distinct from a missing fence",
    (delimiter) => {
      const source = `${open}\n\n${delimiter}\n${delimiter}\n\n${close}`;
      const document = parse(source);
      expect(document.children).toMatchObject([
        { type: "topikCodeTemplate", template: { type: "topikTextTemplate", segments: [] } },
      ]);
      expect(evaluateDocument(document, {}).children).toMatchObject([{ type: "code", value: "" }]);
      const written = writeDocument(document);
      expect(written).toContain(open);
      expect(writeDocument(parse(written))).toBe(written);
    },
  );

  test("accepts ASCII horizontal marker spacing and preserves literal language metadata", () => {
    const source = `{%\ttemplate\tcode\t%}\n~~~text copy={%$name%}\n{%\t$name\t%}\n~~~\n{%\t/template\tcode\t%}`;
    const document = parse(source);
    expect(document.children).toMatchObject([
      {
        type: "topikCodeTemplate",
        lang: "text",
        meta: "copy={%$name%}",
        template: {
          segments: [{ type: "variable", path: ["name"] }],
        },
      },
    ]);
  });

  test.each([
    "{% Template code %}",
    "{% template Code %}",
    "{% template\u00a0code %}",
    "{% template\ncode %}",
    "{% / template code %}",
  ])("does not widen exact marker productions to %j", (marker) => {
    const source = `${marker}\n${fence("example")}\n${close}`;
    expect(parseDocument(source)).toMatchObject({ ok: false, source });
  });
});

describe("template source fidelity", () => {
  test.each(["\n", "\r\n", "\r"])(
    "preserves original offsets and normalizes payload with %j source endings",
    (ending) => {
      const lf = `Introduction.\n\n${code("line one\n{% $name %}\nline three")}\n\nAfter.`;
      const source = lf.replaceAll("\n", ending);
      const document = parse(source);
      const templateNode = document.children[1];
      expect(templateNode.position?.start).toEqual({
        line: 3,
        column: 1,
        offset: source.indexOf(open),
      });
      expect(templateNode.position?.end).toEqual({
        line: 9,
        column: close.length + 1,
        offset: source.indexOf(close) + close.length,
      });
      expect(document.position?.end.offset).toBe(source.length);
      expect(withoutPositions(document)).toEqual(withoutPositions(parse(lf)));
      expect(formatDocument(source)).toMatchObject({
        ok: true,
        source,
        formatted: writeDocument(parse(lf)),
      });
    },
  );

  test.each([
    ["unclosed", "{% $name"],
    ["bare opener", "{%"],
    ["bracket path", "{% $name[0] %}"],
    ["expression", "{% $name + 1 %}"],
    ["function", "{% equals($name, true) %}"],
    ["default", "{% $name ?? value %}"],
    ["nested token", "{% {% $name %} %}"],
    ["line break", "{% $name\n%}"],
    ["carriage return", "{% $name\r%}"],
    ["prototype", "{% $name.prototype %}"],
    ["constructor", "{% $name.constructor %}"],
    ["proto", "{% $name.__proto__ %}"],
    ["empty path segment", "{% $name..value %}"],
  ])("refuses a %s token in an inactive branch as well as attributes", (_name, payload) => {
    for (const source of [title(payload), `{% if $show %}\n${code(payload)}\n{% /if %}`]) {
      const result = compileTopikContent(source, { config: { variables: { show: false } } });
      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("tree");
    }
  });

  test("canonicalizes split literal openers adjacent to active variables without a second scan", () => {
    const segments = [
      { type: "literal", value: "{" },
      { type: "literal", value: "%" },
      { type: "literal", value: " $literal %}{%%" },
      { type: "variable", path: ["name"] },
      { type: "literal", value: "{%%% $tail %}" },
    ];
    const document = root(authoredCode(segments));
    const snapshot = structuredClone(document);
    expect(validateDocument(document)).toEqual([]);
    const written = writeDocument(document);
    const reparsed = parse(written);
    expect(evaluateDocument(reparsed, { name: "{% $unresolved %}" }).children).toMatchObject([
      { type: "code", value: "{% $literal %}{%%{% $unresolved %}{%%% $tail %}" },
    ]);
    expect(writeDocument(reparsed)).toBe(written);
    expect(document).toEqual(snapshot);
  });

  test("keeps plain punctuation and literal-only code explicitly templated", () => {
    const payload = "%} { $name } `name` C:\\tools\\run";
    const document = parse(code(payload));
    expect(document.children).toMatchObject([
      {
        type: "topikCodeTemplate",
        template: {
          segments: [{ type: "literal", value: payload }],
        },
      },
    ]);
    expect(writeDocument(document)).toContain(open);
    expect(evaluateDocument(document, {}).children).toMatchObject([
      { type: "code", value: payload },
    ]);
  });

  test("allows tabs inside token syntax without inserting literal attribute controls", () => {
    const document = parse(title("Before{%\t$name\t%}after"));
    expect(evaluateDocument(document, { name: "Example" }).children).toMatchObject([
      { props: { title: "BeforeExampleafter" } },
    ]);
    expect(writeDocument(document)).toContain('title=t"Before{% $name %}after"');
    expect(parseDocument(title("Before\tafter"))).toMatchObject({ ok: false });
  });

  test.each(['T"{% $name %}"', "t'{% $name %}'", 't "{% $name %}"'])(
    "does not widen the text-template prefix to %s",
    (attribute) => {
      const source = `{% callout title=${attribute} %}\nBody.\n{% /callout %}`;
      expect(parseDocument(source)).toMatchObject({ ok: false, source });
    },
  );

  test("writes caller-built fence runs without ending the opted-in payload early", () => {
    const payload = "``````\n~~~~~~~\n{% $literal %}\n```text\nend";
    const document = root(authoredCode([{ type: "literal", value: payload }]));
    const written = writeDocument(document);
    expect(evaluateDocument(parse(written), {}).children).toMatchObject([
      { type: "code", value: payload },
    ]);
    expect(writeDocument(parse(written))).toBe(written);
  });

  test.each(["```", "~~~~", "{% /template code %}"])(
    "keeps a substituted delimiter line %j in reader code",
    (value) => {
      const document = parse(code("{% $value %}"));
      const reader = evaluateDocument(document, { value });
      expect(reader.children).toMatchObject([{ type: "code", value }]);
      const readerSource = writeDocument(reader);
      expect(parse(readerSource).children).toMatchObject([{ type: "code", value }]);
      expect(nodes(parse(readerSource)).some((node) => node.type === "topikCodeTemplate")).toBe(
        false,
      );
    },
  );
});

describe("template compatibility and admission", () => {
  test.each(["block", "inline"] as const)(
    "preserves a custom %s template on standalone lines",
    (kind) => {
      const registry = mergeTopikContentConfig({
        components: {
          template: {
            kind,
            render: "Template",
            attributes: {},
            children: kind === "block" ? "blocks" : "inline",
          },
          codeTemplate: {
            kind: "block",
            render: "CodeTemplate",
            attributes: {},
            children: "blocks",
          },
        },
      }).components;
      const source =
        kind === "block"
          ? `{% template %}\nBody.\n{% /template %}\n\n{% codeTemplate %}\nMore.\n{% /codeTemplate %}\n\n${code("{% $name %}")}`
          : `Before.\n{% template %}\ninline\n{% /template %}\nAfter.\n\n{% codeTemplate %}\nMore.\n{% /codeTemplate %}\n\n${code("{% $name %}")}`;
      const document = parse(source, registry);
      expect(nodes(document).filter((node) => node.name === "template")).toHaveLength(1);
      expect(nodes(document).filter((node) => node.name === "codeTemplate")).toHaveLength(1);
      expect(nodes(document).filter((node) => node.type === "topikCodeTemplate")).toHaveLength(1);
      const written = writeDocument(document, registry);
      expect(writeDocument(parse(written, registry), registry)).toBe(written);
    },
  );

  test("does not search static Markdown, code metadata or literal attributes for template syntax", () => {
    const source =
      '---\ntitle: t"{% $missing %}"\n---\n\n' +
      '{% figure src="./image.png" alt="{% $missing %}" caption="{%" /%}\n\n' +
      '![{% $missing %}](./image.png "{%")\n\n[Read](./guide "{% $missing %}")\n\n' +
      fence("{% $missing %}", "~~~", "text title={%$missing%}");
    const document = parse(source);
    expect(
      nodes(document).some(
        (node) => node.type === "topikCodeTemplate" || node.type === "topikVariable",
      ),
    ).toBe(false);
    expect(() => evaluateDocument(document, {})).not.toThrow();
  });

  test("refuses templates in asset and interpreted-content slots", () => {
    for (const source of [
      '{% figure src=t"{% $name %}" /%}',
      '{% figure src="./image.png" darkSrc=t"{% $name %}" /%}',
      '{% callout variant=t"{% $name %}" %}\nBody.\n{% /callout %}',
      '{% math content=t"{% $name %}" /%}',
    ]) {
      const result = parseDocument(source);
      expect(result).toMatchObject({ ok: false, source });
      if (!result.ok)
        expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
          "topik-template-location",
        );
    }
    const source = code("{% $name %}", "~~~", "mermaid");
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok)
      expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
        "topik-code-template-language",
      );
  });

  test("refuses an interpreted language after normal Markdown entity decoding", () => {
    const source = code("{% $name %}", "~~~", "m&#101;rmaid");
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok)
      expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
        "topik-code-template-language",
      );
  });

  test("retains the existing unknown-attribute diagnostic for a template value", () => {
    const source = '{% callout unknown=t"{% $name %}" %}\nBody.\n{% /callout %}';
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
        "attribute-undefined",
      );
      expect(result.diagnostics.map((diagnostic) => diagnostic.id)).not.toContain(
        "topik-template-location",
      );
    }
  });

  test("refuses malformed nested author data without invoking getters or coercion callbacks", () => {
    const callback = vi.fn(() => "name");
    const accessorSegment = { type: "literal" };
    Object.defineProperty(accessorSegment, "value", { enumerable: true, get: callback });
    const accessorPath = ["name"];
    Object.defineProperty(accessorPath, "0", { enumerable: true, get: callback });
    const sharedPath = ["name"];
    const sharedSegment = { type: "literal", value: "text" };
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const segments of [
      [accessorSegment],
      [{ type: "variable", path: accessorPath }],
      [
        { type: "variable", path: sharedPath },
        { type: "variable", path: sharedPath },
      ],
      [sharedSegment, sharedSegment],
      [{ type: "variable", path: cycle }],
      [{ type: "literal", value: { toString: callback } }],
      [{ type: "variable", path: ["name"], extra: true }],
      [{ type: "literal", value: "text", extra: true }],
      [{ type: "variable", path: [] }],
      [{ type: "variable", path: ["name", ""] }],
      [{ type: "literal", value: "a\0b" }],
    ]) {
      const document = root(authoredCode(segments));
      expect(() => validateDocument(document)).not.toThrow();
      expect(validateDocument(document).length).toBeGreaterThan(0);
      expect(() => writeDocument(document)).toThrow();
      expect(() => evaluateDocument(document, { name: "Example" })).toThrow();
    }
    expect(callback).not.toHaveBeenCalled();
  });
});

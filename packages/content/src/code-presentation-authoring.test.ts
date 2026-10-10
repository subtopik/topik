import { describe, expect, test, vi } from "vitest";
import { parseDocument, formatDocument, parseDocumentTree } from "./markdown.js";
import { parseTopikContent } from "./content.js";
import { compileTopikContent } from "./compile.js";
import { formatTopikContent } from "./format.js";
import { writeDocument } from "./writer.js";
import { validateDocument } from "./validation.js";
import { sameDocumentMeaning } from "./document-meaning.js";
import { components } from "./registry.js";
import type { ContentDocument, TreeNode } from "./model.js";

const fence = (meta = 'filename="client.ts" lines', value = "first\nsecond\nthird", lang = "ts") =>
  `\`\`\`${lang}${lang && meta ? " " : ""}${meta}\n${value}\n\`\`\``;
function parsed(source: string, registry = components): ContentDocument {
  const result = parseDocument(source, registry);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.document;
}

describe("compact code presentation authoring", () => {
  test("retains explicit options, normalized selections, suffix, and exact payload", () => {
    const document = parsed(
      fence(
        'lines=false highlight="3,1-2,2" startLine=10 collapse="2-3"  legacy\t&amp; \\*',
        " first\t \nsecond  \n",
      ),
    );
    expect(document.children[0]).toMatchObject({
      type: "topikCodePresentation",
      options: { lineNumbers: false, highlight: [[1, 3]], startLine: 10, collapse: [[2, 3]] },
      opaqueMetaSuffix: "  legacy\t& *",
      children: [{ type: "code", lang: "ts", value: " first\t \nsecond  \n" }],
    });
    expect((document.children[0] as unknown as TreeNode).children![0]).not.toHaveProperty("meta");
    const before = structuredClone(document);
    const written = writeDocument(document);
    expect(written).toContain('highlight="1-3"');
    expect(written).toMatch(/^```ts lines=false\s/);
    expect(sameDocumentMeaning(document, parsed(written))).toBe(true);
    expect(writeDocument(parsed(written))).toBe(written);
    expect(document).toEqual(before);
  });

  test("canonicalizes independent collapse regions from source and caller-built documents", () => {
    const value = Array.from({ length: 9 }, (_, index) => `row ${index + 1}`).join("\n");
    const sourceDocument = parsed(fence('startLine=100 collapse="9,4,3-4,8"', value));
    expect(sourceDocument.children[0]).toMatchObject({
      options: {
        startLine: 100,
        collapse: [
          [3, 4],
          [8, 9],
        ],
      },
    });
    const callerDocument = {
      type: "root",
      children: [
        {
          type: "topikCodePresentation",
          options: {
            startLine: 100,
            collapse: [
              [8, 9],
              [4, 4],
              [3, 3],
              [3, 4],
            ],
          },
          opaqueMetaSuffix: "",
          children: [{ type: "code", lang: "ts", value }],
        },
      ],
    } as unknown as ContentDocument;
    expect(validateDocument(callerDocument)).toEqual([]);
    expect(sameDocumentMeaning(sourceDocument, callerDocument)).toBe(true);
    const written = writeDocument(sourceDocument);
    expect(written).toContain('startLine=100 collapse="3-4,8-9"');
    for (const document of [sourceDocument, callerDocument]) {
      const before = structuredClone(document);
      expect(writeDocument(document)).toBe(written);
      const reparsed = parsed(written);
      expect(sameDocumentMeaning(document, reparsed)).toBe(true);
      expect(writeDocument(reparsed)).toBe(written);
      expect(document).toEqual(before);
    }
  });

  test.each([
    { selection: "1", value: "only", intervals: [[1, 1]] },
    { selection: "1-3", value: "first\nsecond\nthird", intervals: [[1, 3]] },
  ])("admits collapse=$selection for the whole payload", ({ selection, value, intervals }) => {
    const document = parsed(fence(`startLine=100 collapse="${selection}"`, value));
    expect(document.children[0]).toMatchObject({
      options: { startLine: 100, collapse: intervals },
    });
    expect(validateDocument(document)).toEqual([]);
    expect(sameDocumentMeaning(document, parsed(writeDocument(document)))).toBe(true);
  });

  test.each([
    "collapse",
    'collapse=""',
    'collapse="0"',
    'collapse="-2"',
    'collapse="2-"',
    'collapse="2-1"',
    'collapse="1, 2"',
    'collapse="1,,2"',
    'collapse="1,2,"',
    'collapse="4"',
    'startLine=100 collapse="100"',
    'collapse="1" collapse="2"',
    "collapse=true",
    "collapse=1.5",
  ])("refuses invalid collapse authoring %j", (metadata) => {
    const result = parseDocumentTree(fence(metadata));
    expect(result).not.toHaveProperty("document");
    expect(result.diagnostics).toMatchObject([{ option: "collapse" }]);
    expect(formatDocument(fence(metadata)).ok).toBe(false);
  });

  test("retains structural and collapse diagnostics from the same source", () => {
    const source = `{% callout variant=1 %}\nBefore.\n{% /callout %}\n\n${fence('collapse="4"')}`;
    const result = parseDocumentTree(source);
    expect(result).not.toHaveProperty("document");
    expect(result.diagnostics).toMatchObject([
      { id: "attribute-type-invalid", line: 1, column: 1 },
      { id: "topik-code-presentation-line-bounds", option: "collapse", line: 5, column: 1 },
    ]);
  });

  test.each([
    { collapse: [] },
    { collapse: [[0, 1]] },
    { collapse: [[2, 1]] },
    { collapse: [[1]] },
    { collapse: [[1, 4]] },
    { collapse: "1-2" },
    { collapse: 1 },
    { collapse: null },
  ])("refuses invalid caller-built collapse selections $collapse", ({ collapse }) => {
    const document = {
      type: "root",
      children: [
        {
          type: "topikCodePresentation",
          options: { collapse, startLine: 100 },
          opaqueMetaSuffix: "",
          children: [{ type: "code", lang: "text", value: "first\nsecond\nthird" }],
        },
      ],
    } as unknown as ContentDocument;
    expect(validateDocument(document)).toEqual(
      expect.arrayContaining([expect.objectContaining({ option: "collapse" })]),
    );
    expect(() => writeDocument(document)).toThrow();
  });

  test("scans raw quoted attributes before CommonMark decoding and preserves opaque suffix", () => {
    const document = parsed(
      '~~~ts title="&amp; \\"quoted\\" C:&#92;temp &#96;"  &amp;#38; &#92;* &#96;\nvalue\n~~~',
    );
    expect(document.children[0]).toMatchObject({
      options: { title: '& "quoted" C:\\temp `' },
      opaqueMetaSuffix: "  &#38; \\* `",
    });
    const written = writeDocument(document);
    expect(written).toContain("title=");
    expect(written).toContain("  &#38;#38; &#92;* &#96;");
    expect(sameDocumentMeaning(document, parsed(written))).toBe(true);
  });

  test("keeps unknown-only metadata opaque", () => {
    for (const meta of [
      'custom-code:1 {"unknown":true}',
      'legacy filename="literal.ts"',
      "lineNumbers=true",
      "collapseAfter=1",
      'collapseAfter=1 collapse="1"',
      "Lines",
    ])
      expect(parsed(fence(meta)).children[0]).toMatchObject({ type: "code", meta });
    expect(parsed(fence('lines legacy title="opaque"')).children[0]).toMatchObject({
      options: { lineNumbers: true },
      opaqueMetaSuffix: ' legacy title="opaque"',
    });
  });

  test.each([
    "lines:note",
    "wrap:note",
    "filename:note",
    "lines\\=false",
    'collapse="1"',
    "collapse",
    "collapse=1",
    "collapse:note",
    "collapse\\=1",
  ])("round-trips caller-built literal metadata %j in code and templates", (meta) => {
    for (const type of ["code", "topikCodeTemplate"]) {
      const node =
        type === "code"
          ? { type, lang: "text", meta, value: "value" }
          : {
              type,
              lang: "text",
              meta,
              template: {
                type: "topikTextTemplate",
                segments: [{ type: "literal", value: "value" }],
              },
            };
      const document = { type: "root", children: [node] } as unknown as ContentDocument;
      expect(validateDocument(document)).toEqual([]);
      const written = writeDocument(document);
      const reparsed = parsed(written);
      expect(reparsed.children[0]).toMatchObject({ type, lang: "text", meta });
      expect(sameDocumentMeaning(document, reparsed)).toBe(true);
      expect(writeDocument(reparsed)).toBe(written);
    }
  });

  test("preserves ordinary custom components", () => {
    const inlineRegistry = {
      ...components,
      snippetBox: {
        kind: "inline" as const,
        render: "SnippetBox",
        attributes: { variant: { type: "string" as const } },
        children: "inline" as const,
      },
    };
    expect(
      parsed('{% snippetBox variant="example" %}Label{% /snippetBox %}', inlineRegistry)
        .children[0],
    ).toMatchObject({
      type: "paragraph",
      children: [{ type: "topikComponent", name: "snippetBox", props: { variant: "example" } }],
    });
    const blockRegistry = {
      ...inlineRegistry,
      snippetBox: {
        ...inlineRegistry.snippetBox,
        kind: "block" as const,
        children: "blocks" as const,
      },
    };
    expect(
      formatDocument(
        `{% snippetBox variant="example" %}\n${fence()}\n{% /snippetBox %}`,
        blockRegistry,
      ),
    ).toMatchObject({ ok: true });
  });

  test.each(["", "unknown-language", "text"])(
    "supports empty payload and language %j",
    (language) => {
      const document = parsed(fence("lines", "", language));
      expect(document.children[0]).toMatchObject({
        options: { lineNumbers: true },
        opaqueMetaSuffix: "",
        children: [{ value: "", lang: language || null }],
      });
      expect(sameDocumentMeaning(document, parsed(writeDocument(document)))).toBe(true);
    },
  );

  test("supports language-free flags and attributes while bare string keys remain languages", () => {
    for (const header of [
      "lines",
      "wrap",
      'filename="a b.ts"',
      'filename="foo&#32;bar"',
      'collapse="1"',
    ])
      expect(parsed(fence(header, "value", "")).children[0]).toMatchObject({
        type: "topikCodePresentation",
        children: [{ lang: null }],
      });
    for (const language of ["filename", "title", "highlight", "focus", "collapse", "startLine"])
      expect(parsed(fence("", "value", language)).children[0]).toMatchObject({
        type: "code",
        lang: language,
      });
    expect(parsed('    ts filename="literal.ts" lines').children[0]).toMatchObject({
      type: "code",
      value: 'ts filename="literal.ts" lines',
    });
  });

  test("supports container indentation, code tabs, and every branch", () => {
    const code = fence('highlight="2"');
    for (const source of [
      code
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
      "- " + code.split("\n").join("\n  "),
      `{% callout %}\n${code}\n{% /callout %}`,
      `{% codeGroup %}\n{% codeTab title="Example" %}\n${code}\n\n${code}\n{% /codeTab %}\n{% /codeGroup %}`,
      `{% if $enabled %}\n${code}\n{% else /%}\n${code}\n{% /if %}`,
    ])
      expect(formatDocument(source)).toMatchObject({ ok: true });
  });

  test("preserves unevaluated code-template composition through repeated writing", () => {
    const source = `{% template code %}\n${fence('focus="2" collapse="1"', "npm install {% $package.name %}\n{%% $literal %}")}\n{% /template code %}`;
    const document = parsed(source);
    expect(document.children[0]).toMatchObject({
      options: { focus: [[2, 2]], collapse: [[1, 1]] },
      children: [
        {
          type: "topikCodeTemplate",
          template: {
            segments: [
              { type: "literal", value: "npm install " },
              { type: "variable", path: ["package", "name"] },
              { type: "literal", value: "\n{% $literal %}" },
            ],
          },
        },
      ],
    });
    const written = writeDocument(document);
    expect(written).toContain("{% template code %}");
    expect(written).toContain("{% $package.name %}");
    expect(writeDocument(parsed(written))).toBe(written);
  });

  test("supports punctuation in languages and literal entity-looking labels", () => {
    const document = parsed(fence('title="literal&#38;amp;" lines', "value", "custom-code:1"));
    expect(document.children[0]).toMatchObject({
      options: { title: "literal&amp;", lineNumbers: true },
      children: [{ lang: "custom-code:1" }],
    });
    expect(sameDocumentMeaning(document, parsed(writeDocument(document)))).toBe(true);
    const source = `{% template code %}\n${fence('filename="foo&#32;bar"', "value", "")}\n{% /template code %}`;
    expect(parsed(source).children[0]).toMatchObject({
      options: { filename: "foo bar" },
      children: [{ lang: null, type: "topikCodeTemplate" }],
    });
  });

  test.each(["lines", "wrap", "filename=literal", "collapse", "collapse=1"])(
    "round-trips literal reserved language %j",
    (language) => {
      const encoded = `&#${language.charCodeAt(0)};${language.slice(1)}`;
      const document = parsed(fence("lines", "value", encoded));
      expect(document.children[0]).toMatchObject({ children: [{ lang: language }] });
      expect(sameDocumentMeaning(document, parsed(writeDocument(document)))).toBe(true);
      const ordinaryTemplate = `{% template code %}\n${fence("", "value", encoded)}\n{% /template code %}`;
      expect(
        sameDocumentMeaning(
          parsed(ordinaryTemplate),
          parsed(writeDocument(parsed(ordinaryTemplate))),
        ),
      ).toBe(true);
    },
  );

  test.each([
    "filename",
    "highlight",
    'filename="unterminated',
    "lines=0",
    "lines lines",
    'highlight="4"',
    'focus="0"',
    'highlight="2-1"',
    'highlight="1, 2"',
    'filename=""',
    'filename="one" filename="two"',
    'title="&#10;"',
    'added="1" removed="1"',
  ])("visibly refuses malformed or invalid recognized attributes %j", (metadata) => {
    expect(parseDocument(fence(metadata)).ok).toBe(false);
  });
  test.each(["\n", "\r\n"])(
    "reports every malformed presentation and surrounding authoring error with %j line endings",
    (ending) => {
      const source = [
        "{% callout variant=1 %}",
        "Before.",
        "{% /callout %}",
        "",
        "{% if unknown($before) %}",
        "First branch.",
        "{% /if %}",
        "",
        ...fence('highlight="2"', "only")
          .split("\n")
          .map((line) => `> ${line}`),
        "",
        "{% template code %}",
        fence('focus="0"', "only", "sh"),
        "{% /template code %}",
        "",
        "{% if not() %}",
        "Last branch.",
        "{% /if %}",
        "",
        '{% callout variant="invalid" %}',
        "After.",
        "{% /callout %}",
      ]
        .join("\n")
        .replaceAll("\n", ending);
      const result = parseDocumentTree(source);
      expect(result.source).toBe(source);
      expect(result).not.toHaveProperty("document");
      expect(result).not.toHaveProperty("index");
      expect(result.diagnostics).toMatchObject([
        { id: "attribute-type-invalid", line: 1, column: 1 },
        {
          message: expect.stringContaining("Unknown expression function unknown"),
          line: 5,
          column: 1,
        },
        {
          id: "topik-code-presentation-line-bounds",
          option: "highlight",
          line: 9,
          column: 3,
        },
        { id: "topik-code-presentation-lines", option: "focus", line: 13, column: 1 },
        { message: expect.stringContaining("not requires 1 argument(s)"), line: 19, column: 1 },
        { id: "attribute-value-invalid", line: 23, column: 1 },
      ]);
      expect(() => parseTopikContent(source)).toThrow("Content could not be parsed");
      const formatted = formatDocument(source);
      expect(formatted).toEqual({ ok: false, source, diagnostics: result.diagnostics });
      const compiled = compileTopikContent(source);
      expect(compiled).toMatchObject({
        ok: false,
        source,
        diagnostics: result.diagnostics.map(({ id, line, column, option }) => ({
          id: id ?? "parse-error",
          lines: [line],
          ...(id?.startsWith("topik-code-presentation-") ? { column } : {}),
          ...(option ? { option } : {}),
        })),
      });
      expect(compiled).not.toHaveProperty("tree");
      expect(formatTopikContent(source)).toEqual(compiled);
    },
  );
  test("stops at a hard limit after an invalid presentation", () => {
    const source = fence('highlight="4"') + "\n\n" + fence("lines", "x\n".repeat(20_000));
    const result = parseDocumentTree(source);
    expect(result).not.toHaveProperty("document");
    expect(result.diagnostics).toMatchObject([{ id: "topik-content-limit" }]);
  });
  test("refuses presented Mermaid while ordinary Mermaid stays available", () => {
    expect(parseDocument(fence("lines", "graph TD", "mermaid")).ok).toBe(false);
    expect(parseDocument(fence("", "graph TD", "mermaid")).ok).toBe(true);
  });
  test("caller-built admission agrees and semantics distinguish explicit defaults", () => {
    const make = (
      options: unknown,
      child: unknown = { type: "code", value: "one\ntwo", lang: "text" },
      suffix: unknown = "",
    ) =>
      ({
        type: "root",
        children: [
          { type: "topikCodePresentation", options, opaqueMetaSuffix: suffix, children: [child] },
        ],
      }) as unknown as ContentDocument;
    const document = make({
      highlight: [
        [2, 2],
        [1, 1],
      ],
      wrap: false,
    });
    expect(validateDocument(document)).toEqual([]);
    expect(sameDocumentMeaning(document, parsed(writeDocument(document)))).toBe(true);
    expect(
      sameDocumentMeaning(make({ lineNumbers: true }), make({ lineNumbers: true, wrap: false })),
    ).toBe(false);
    for (const candidate of [
      make({ highlight: [[3, 3]] }),
      make({ collapseAfter: 1 }),
      make({}, { type: "code", value: "x", lang: "mermaid" }),
      make({}, { type: "code", value: "x", lang: "text", meta: "duplicate" }),
      make({}, undefined, "suffix without separator"),
      make({ title: "bad\nlabel" }),
    ]) {
      expect(validateDocument(candidate).length).toBeGreaterThan(0);
      expect(() => writeDocument(candidate)).toThrow();
    }
    const first = make({ highlight: [[1, 1]] }).children[0] as unknown as TreeNode;
    const second = structuredClone(first);
    second.options = first.options;
    expect(
      validateDocument({ type: "root", children: [first, second] } as unknown as ContentDocument)
        .length,
    ).toBeGreaterThan(0);
  });
  test.each([{}, [null], [{ type: "literal", value: 123 }]])(
    "refuses malformed presented template segments without executing row measurement %j",
    (segments) => {
      const document = {
        type: "root",
        children: [
          {
            type: "topikCodePresentation",
            options: { lineNumbers: true },
            opaqueMetaSuffix: "",
            children: [
              {
                type: "topikCodeTemplate",
                lang: "text",
                template: { type: "topikTextTemplate", segments },
              },
            ],
          },
        ],
      } as unknown as ContentDocument;
      expect(() => validateDocument(document)).not.toThrow();
      expect(validateDocument(document).length).toBeGreaterThan(0);
      expect(() => writeDocument(document)).toThrow();
    },
  );

  test("admits structure and aggregate presentation budgets before registry callbacks", () => {
    const validate = vi.fn(() => []);
    const registry = {
      ...components,
      notice: {
        kind: "block" as const,
        render: "Notice",
        attributes: {},
        children: "blocks" as const,
        validate,
      },
    };
    const notice = (body: string) => `{% notice %}\n${body}\n{% /notice %}`;
    const manyRows = () => fence("lines", "x\n".repeat(6_000));
    for (const source of [
      notice(fence('highlight="4"')),
      notice(fence('collapse="4"')),
      notice(fence('highlight="4"')) + "\n\n" + notice(fence('focus="0"')),
      notice(fence("lines", "x\n".repeat(12_000))),
      notice(manyRows()) + "\n\n" + notice(manyRows()),
    ]) {
      expect(parseDocument(source, registry).ok).toBe(false);
      expect(validate).not.toHaveBeenCalled();
    }
    expect(parseDocument(notice(fence()), registry).ok).toBe(true);
    expect(validate).toHaveBeenCalledOnce();
  });

  test("retains callback diagnostics, parent blocking, and thrown errors after admission", () => {
    const parent = vi.fn(() => []);
    const child = vi.fn(() => [{ id: "notice-problem", message: "Invalid notice" }]);
    const registry = {
      ...components,
      outer: {
        kind: "block" as const,
        render: "Outer",
        attributes: {},
        children: "blocks" as const,
        validate: parent,
      },
      notice: {
        kind: "block" as const,
        render: "Notice",
        attributes: {},
        children: "blocks" as const,
        validate: child,
      },
    };
    const source = `{% outer %}\n{% notice %}\n${fence()}\n{% /notice %}\n{% /outer %}`;
    expect(parseDocument(source, registry)).toMatchObject({
      ok: false,
      diagnostics: [{ id: "notice-problem" }],
    });
    expect(child).toHaveBeenCalledOnce();
    expect(parent).not.toHaveBeenCalled();
    registry.notice.validate = vi.fn(() => {
      throw new Error("Callback failure");
    });
    expect(() => parseDocument(source, registry)).toThrow("Callback failure");
  });
});

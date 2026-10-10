import { describe, expect, test, vi } from "vitest";
import { parseDocument, formatDocument } from "./markdown.js";
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
        'lines=false highlight="3,1-2,2" startLine=10 collapseAfter=1  legacy\t&amp; \\*',
        " first\t \nsecond  \n",
      ),
    );
    expect(document.children[0]).toMatchObject({
      type: "topikCodePresentation",
      options: { lineNumbers: false, highlight: [[1, 3]], startLine: 10, collapseAfter: 1 },
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
      "Lines",
    ])
      expect(parsed(fence(meta)).children[0]).toMatchObject({ type: "code", meta });
    expect(parsed(fence('lines legacy title="opaque"')).children[0]).toMatchObject({
      options: { lineNumbers: true },
      opaqueMetaSuffix: ' legacy title="opaque"',
    });
  });

  test.each(["lines:note", "wrap:note", "filename:note", "lines\\=false"])(
    "round-trips caller-built literal metadata %j in code and templates",
    (meta) => {
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
    },
  );

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
    for (const header of ["lines", "wrap", 'filename="a b.ts"', 'filename="foo&#32;bar"'])
      expect(parsed(fence(header, "value", "")).children[0]).toMatchObject({
        type: "topikCodePresentation",
        children: [{ lang: null }],
      });
    for (const language of ["filename", "title", "highlight", "focus", "startLine"])
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
    const source = `{% template code %}\n${fence('focus="2"', "npm install {% $package.name %}\n{%% $literal %}")}\n{% /template code %}`;
    const document = parsed(source);
    expect(document.children[0]).toMatchObject({
      options: { focus: [[2, 2]] },
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

  test.each(["lines", "wrap", "filename=literal"])(
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

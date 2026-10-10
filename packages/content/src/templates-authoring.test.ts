import { describe, expect, test, vi } from "vite-plus/test";
import { ContentLimitError } from "./limits.js";
import {
  components,
  extractTopikAssetOccurrences,
  formatDocument,
  mergeTopikContentConfig,
  parseDocument,
  rewriteTopikAssetOccurrences,
  TOPIK_CONTENT_SCHEMA_VERSION,
  validateDocument,
  writeDocument,
  type ContentDocument,
} from "./index.js";

const variable = { type: "variable", path: ["package", "name"] };
const template = { type: "topikTextTemplate", segments: [variable] };

function parsed(source: string) {
  const result = parseDocument(source);
  expect(result).toMatchObject({ ok: true, source });
  if (!result.ok) throw new Error("Expected supported authoring source");
  return result.document;
}

function authored(value: unknown): ContentDocument {
  return value as ContentDocument;
}

describe("text template authoring", () => {
  test("declares the exact canonical text slots and content version", () => {
    expect(TOPIK_CONTENT_SCHEMA_VERSION).toBe("0.2.2");
    for (const name of ["callout", "accordion", "card", "tab", "step", "codeTab"])
      expect(components[name].attributes.title).toMatchObject({ interpolation: "text" });
    for (const name of ["alt", "caption"])
      expect(components.figure.attributes[name]).toMatchObject({ interpolation: "text" });
    for (const name of ["src", "darkSrc"])
      expect(components.figure.attributes[name]).not.toHaveProperty("interpolation");
  });

  test("preserves mixed, escaped, empty and literal-only attribute template identity", () => {
    for (const [value, segments] of [
      [
        "Install {% $package.name %} {%% $literal %}",
        [
          { type: "literal", value: "Install " },
          variable,
          { type: "literal", value: " {% $literal %}" },
        ],
      ],
      ["", []],
      ["Static title", [{ type: "literal", value: "Static title" }]],
    ] as const) {
      const document = parsed(`{% callout title=t"${value}" %}\nBody.\n{% /callout %}`);
      expect(document.children[0]).toMatchObject({
        props: {
          title: { type: "topikTextTemplate", segments },
        },
      });
      const snapshot = structuredClone(document);
      const written = writeDocument(document);
      expect(written).toContain('title=t"');
      expect(writeDocument(parsed(written))).toBe(written);
      expect(document).toEqual(snapshot);
    }
  });

  test("admits every supported attribute without changing ordinary strings", () => {
    for (const source of [
      '{% accordion title=t"{% $package.name %}" %}\nBody.\n{% /accordion %}',
      '{% cardGrid %}\n{% card title=t"{% $package.name %}" %}\nBody.\n{% /card %}\n{% /cardGrid %}',
      '{% tabs %}\n{% tab title=t"{% $package.name %}" %}\nBody.\n{% /tab %}\n{% /tabs %}',
      '{% steps %}\n{% step title=t"{% $package.name %}" %}\nBody.\n{% /step %}\n{% /steps %}',
      '{% codeGroup %}\n{% codeTab title=t"{% $package.name %}" %}\n```sh\nx\n```\n{% /codeTab %}\n{% /codeGroup %}',
      '{% figure src="./image.png" alt=t"{% $package.name %}" caption=t"Package {% $package.name %}" /%}',
    ])
      expect(formatDocument(source)).toMatchObject({ ok: true });
    expect(
      parsed('{% callout title="{% $package.name %}" %}\nBody.\n{% /callout %}').children[0],
    ).toMatchObject({ props: { title: "{% $package.name %}" } });
  });

  test("rejects template values in literal-only and custom attributes", () => {
    const result = parseDocument(
      '{% cardGrid %}\n{% card title="Card" href=t"{% $package.name %}" %}\nBody.\n{% /card %}\n{% /cardGrid %}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((item) => item.id)).toContain("topik-template-location");
    const registry = mergeTopikContentConfig({
      components: {
        notice: {
          kind: "block",
          render: "Notice",
          attributes: { title: { type: "string" } },
          children: "blocks",
        },
      },
    }).components;
    const custom = parseDocument(
      '{% notice title=t"{% $package.name %}" %}\nBody.\n{% /notice %}',
      registry,
    );
    expect(custom.ok).toBe(false);
    if (!custom.ok)
      expect(custom.diagnostics.map((item) => item.id)).toContain("topik-template-location");
  });

  test("refuses custom inline promotion of a canonical text slot in table cells", () => {
    const registry = {
      ...components,
      callout: { ...components.callout, kind: "inline" as const, children: "inline" as const },
    };
    const result = parseDocument(
      '| {% callout title=t"Title" %}Body{% /callout %} |\n| --- |\n| Cell |',
      registry,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((item) => item.id)).toContain("topik-template-location");
  });

  test("normalizes split literal openers before source escaping without mutating callers", () => {
    const document = authored({
      type: "root",
      children: [
        {
          type: "topikComponent",
          name: "callout",
          props: {
            title: {
              type: "topikTextTemplate",
              segments: [
                { type: "literal", value: "{" },
                { type: "literal", value: "%" },
                { type: "literal", value: " $name %}" },
                { type: "literal", value: "" },
              ],
            },
          },
          children: [],
        },
      ],
    });
    const snapshot = structuredClone(document);
    expect(validateDocument(document)).toEqual([]);
    const written = writeDocument(document);
    expect(written).toContain('title=t"{%% $name %}"');
    expect(parsed(written).children[0]).toMatchObject({
      props: {
        title: {
          type: "topikTextTemplate",
          segments: [{ type: "literal", value: "{% $name %}" }],
        },
      },
    });
    expect(document).toEqual(snapshot);
  });

  test("refuses malformed, unsafe, control and executable template data", () => {
    const make = (title: unknown) =>
      authored({
        type: "root",
        children: [
          {
            type: "topikComponent",
            name: "callout",
            props: { title },
            children: [],
          },
        ],
      });
    for (const title of [
      { ...template, extra: true },
      { type: "topikTextTemplate", segments: [{ type: "variable", path: ["constructor"] }] },
      { type: "topikTextTemplate", segments: [{ type: "literal", value: "two\nlines" }] },
      { type: "topikTextTemplate", segments: [{ type: "literal", value: () => "text" }] },
    ]) {
      expect(validateDocument(make(title)).length).toBeGreaterThan(0);
      expect(() => writeDocument(make(title))).toThrow();
    }
    const getter = {
      type: "topikTextTemplate",
      get segments() {
        throw new Error("Do not execute");
      },
    };
    expect(() => validateDocument(make(getter))).not.toThrow();
    expect(validateDocument(make(getter)).length).toBeGreaterThan(0);
    const shared = { type: "literal", value: "text" };
    expect(
      validateDocument(make({ type: "topikTextTemplate", segments: [shared, shared] })).length,
    ).toBeGreaterThan(0);
  });
});

describe("asset references beside authored text templates", () => {
  const source =
    '{% figure src="./image.png" darkSrc="./dark.png" alt=t"{% $package.name %}" caption=t"Package {% $package.name %}" /%}';

  test("retains template meaning without resolving or inventing scalar asset semantics", () => {
    const occurrences = extractTopikAssetOccurrences(source);
    expect(occurrences).toHaveLength(2);
    for (const occurrence of occurrences) {
      expect(occurrence.semantics).toMatchObject({
        altTemplate: template,
        captionTemplate: {
          type: "topikTextTemplate",
          segments: [{ type: "literal", value: "Package " }, variable],
        },
      });
      expect(occurrence.semantics).not.toHaveProperty("alt");
      expect(occurrence.semantics).not.toHaveProperty("decorative");
      expect(occurrence.semantics).not.toHaveProperty("caption");
    }
  });

  test("isolates nested occurrence metadata from authored source during replacement callbacks", () => {
    const seen: unknown[] = [];
    const result = rewriteTopikAssetOccurrences(source, (occurrence) => {
      const semantics = occurrence.semantics as {
        altTemplate?: { segments: Array<{ path?: string[] }> };
      };
      expect(semantics.altTemplate).toEqual(template);
      seen.push(structuredClone(semantics.altTemplate));
      semantics.altTemplate!.segments[0].path![0] = "modified";
      return occurrence.slot === "figure.src" ? "./replacement.png" : undefined;
    });
    expect(seen).toHaveLength(2);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected supported asset replacement");
    expect(result.content).toContain('src="./replacement.png"');
    expect(parsed(result.content).children[0]).toMatchObject({ props: { alt: template } });
  });
});

describe("code template authoring", () => {
  const source =
    "{% template code %}\n```sh\nnpm install {% $package.name %}\n{%% $literal %} C:\\Users\\name\n```\n{% /template code %}";

  test("retains code opt-in and templates through parsing and repeated writing", () => {
    const document = parsed(source);
    expect(document.children[0]).toMatchObject({
      type: "topikCodeTemplate",
      lang: "sh",
      template: {
        type: "topikTextTemplate",
        segments: [
          { type: "literal", value: "npm install " },
          variable,
          { type: "literal", value: "\n{% $literal %} C:\\Users\\name" },
        ],
      },
    });
    const written = writeDocument(document);
    expect(written).toContain("{% template code %}");
    expect(writeDocument(parsed(written))).toBe(written);
  });

  test("supports code tabs and all branches without evaluating context", () => {
    const codeTab =
      '{% codeGroup %}\n{% codeTab title=t"{% $package.name %}" %}\n' +
      source +
      "\n{% /codeTab %}\n{% /codeGroup %}";
    expect(formatDocument(codeTab)).toMatchObject({ ok: true });
    const conditional = "{% if $enabled %}\n" + source + "\n{% else /%}\n" + source + "\n{% /if %}";
    const written = writeDocument(parsed(conditional));
    expect(written.match(/\{% template code %\}/g)).toHaveLength(2);
    expect(written.match(/\{% \$package\.name %\}/g)).toHaveLength(2);
  });

  test("accepts caller-built leaves but rejects nontext handlers and unknown fields", () => {
    const code = { type: "topikCodeTemplate", lang: "sh", template: structuredClone(template) };
    const make = (node: unknown) => authored({ type: "root", children: [node] });
    expect(validateDocument(make(code))).toEqual([]);
    expect(writeDocument(make(code))).toContain("{% $package.name %}");
    for (const node of [
      { ...code, lang: "mermaid" },
      { ...code, lang: "shell extra" },
      { ...code, lang: "" },
      { ...code, meta: "" },
      { ...code, value: "not authoritative" },
    ]) {
      expect(validateDocument(make(node)).length).toBeGreaterThan(0);
      expect(() => writeDocument(make(node))).toThrow();
    }
  });

  test("preserves literal metadata tabs from source and caller-built leaves", () => {
    const document = parsed(
      "{% template code %}\n```text first\tsecond\nx\n```\n{% /template code %}",
    );
    expect(document.children[0]).toMatchObject({ meta: "first\tsecond" });
    expect(parsed(writeDocument(document)).children[0]).toMatchObject({ meta: "first\tsecond" });
    const caller = authored({
      type: "root",
      children: [
        {
          type: "topikCodeTemplate",
          lang: "text",
          meta: "first\tsecond &\\`",
          template: { type: "topikTextTemplate", segments: [{ type: "literal", value: "x" }] },
        },
      ],
    });
    expect(validateDocument(caller)).toEqual([]);
    expect(parsed(writeDocument(caller)).children[0]).toMatchObject({ meta: "first\tsecond &\\`" });
  });

  test("preserves metadata spaces across canonical writing", () => {
    for (const meta of [" copy", "  ", "copy "]) {
      const document = authored({
        type: "root",
        children: [
          {
            type: "topikCodeTemplate",
            lang: "text",
            meta,
            template: { type: "topikTextTemplate", segments: [] },
          },
        ],
      });
      expect(validateDocument(document)).toEqual([]);
      expect(parsed(writeDocument(document)).children[0]).toMatchObject({ meta });
    }
  });
});

describe("template source allocation admission", () => {
  function code(value: string) {
    return {
      type: "topikCodeTemplate",
      lang: "text",
      template: { type: "topikTextTemplate", segments: [{ type: "literal", value }] },
    };
  }

  test("applies the shared tree budget to template segments and bounds path arrays", () => {
    for (const segments of [
      Array.from({ length: 50_001 }, () => ({ type: "literal", value: "" })),
      [{ type: "variable", path: Array.from({ length: 50_001 }, () => "a") }],
    ]) {
      const document = authored({
        type: "root",
        children: [
          { type: "topikCodeTemplate", template: { type: "topikTextTemplate", segments } },
        ],
      });
      expect(validateDocument(document).map((item) => item.id)).toContain("topik-content-limit");
    }
  });

  test.each([
    ["escaped opener growth", () => [code("{%".repeat(340_000))]],
    ["fence growth", () => [code("`".repeat(260_000) + "~".repeat(260_000))]],
    ["aggregate template growth", () => [code("{%".repeat(170_000)), code("{%".repeat(170_000))]],
    [
      "quoted attribute growth",
      () => [
        {
          type: "topikComponent",
          name: "callout",
          props: {
            title: {
              type: "topikTextTemplate",
              segments: [{ type: "literal", value: '"'.repeat(520_000) }],
            },
          },
          children: [],
        },
      ],
    ],
    [
      "template growth alongside static content",
      () => [
        {
          type: "topikComponent",
          name: "callout",
          props: {
            title: {
              type: "topikTextTemplate",
              segments: [{ type: "literal", value: "\\".repeat(300_000) }],
            },
          },
          children: [],
        },
        { type: "code", lang: "text", value: "x".repeat(500_000) },
      ],
    ],
    [
      "template growth alongside ordinary quoted attributes",
      () => [
        {
          type: "topikComponent",
          name: "callout",
          props: {
            title: "\\".repeat(200_000),
          },
          children: [],
        },
        code("x".repeat(700_000)),
      ],
    ],
    [
      "template growth alongside Markdown escapes",
      () => [
        { type: "paragraph", children: [{ type: "text", value: "\\".repeat(20_000) }] },
        code("x".repeat(970_000)),
      ],
    ],
    [
      "empty code template separators",
      () =>
        Array.from({ length: 19_000 }, () => ({
          ...code(""),
          template: { type: "topikTextTemplate", segments: [] },
        })),
    ],
    [
      "template attribute component framing",
      () => [
        {
          type: "topikComponent",
          name: "callout",
          props: {
            title: {
              type: "topikTextTemplate",
              segments: [{ type: "literal", value: "\\".repeat(499_989) }],
            },
          },
          children: [],
        },
      ],
    ],
  ])("refuses %s before source-emission allocations", (_name, children) => {
    const document = authored({ type: "root", children: children() });
    expect(validateDocument(document)).toEqual([]);
    const originalReplace = Object.getOwnPropertyDescriptor(String.prototype, "replaceAll")!
      .value as (this: string, search: string | RegExp, replacement: unknown) => string;
    const originalRepeat = Object.getOwnPropertyDescriptor(String.prototype, "repeat")!.value as (
      this: string,
      count: number,
    ) => string;
    const expanded = vi.fn();
    const replace = vi.spyOn(String.prototype, "replaceAll").mockImplementation(function (
      this: string,
      search: string | RegExp,
      replacement: unknown,
    ) {
      if (this.length > 100_000 && search === "{%" && replacement === "{%%") {
        expanded();
        throw new Error("Expanded source escaping must follow admission");
      }
      return originalReplace.call(this, search, replacement);
    });
    const repeat = vi.spyOn(String.prototype, "repeat").mockImplementation(function (
      this: string,
      count,
    ) {
      if (count > 3) {
        expanded();
        throw new Error("Expanded fence allocation must follow admission");
      }
      return originalRepeat.call(this, count);
    });
    try {
      expect(() => writeDocument(document)).toThrow(ContentLimitError);
      expect(expanded).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
      repeat.mockRestore();
    }
  });

  test("keeps representable template source near the fixed limit", () => {
    const document = authored({ type: "root", children: [code("x".repeat(999_900))] });
    const written = writeDocument(document);
    expect(written.length).toBeLessThanOrEqual(1_000_000);
    expect(parsed(written).children[0]).toMatchObject({
      template: code("x".repeat(999_900)).template,
    });
  });

  test("admits exact near-limit attribute output including all framing", () => {
    const document = authored({
      type: "root",
      children: [
        {
          type: "topikComponent",
          name: "callout",
          props: {
            title: {
              type: "topikTextTemplate",
              segments: [{ type: "literal", value: "\\".repeat(499_980) }],
            },
          },
          children: [],
        },
      ],
    });
    const written = writeDocument(document);
    expect(written.length).toBe(999_999);
  });

  test.each([
    ["blockquote", (leaf: unknown) => ({ type: "blockquote", children: [leaf] })],
    [
      "unordered list",
      (leaf: unknown) => ({
        type: "list",
        ordered: false,
        children: [{ type: "listItem", children: [leaf] }],
      }),
    ],
    [
      "ordered list",
      (leaf: unknown) => ({
        type: "list",
        ordered: true,
        start: 999,
        children: [{ type: "listItem", children: [leaf] }],
      }),
    ],
    [
      "nested list and quote",
      (leaf: unknown) => ({
        type: "list",
        ordered: true,
        start: 999,
        children: [{ type: "listItem", children: [{ type: "blockquote", children: [leaf] }] }],
      }),
    ],
  ])("refuses template line amplification inside %s before emission", (_name, wrap) => {
    const document = authored({ type: "root", children: [wrap(code("x\n".repeat(300_000)))] });
    expect(validateDocument(document)).toEqual([]);
    const replace = vi.spyOn(String.prototype, "replaceAll").mockImplementation(() => {
      throw new Error("Template emission must follow container admission");
    });
    try {
      expect(() => writeDocument(document)).toThrow(ContentLimitError);
      expect(replace).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
    }
  });

  test("counts empty code lines using actual quote and list prefix behavior", () => {
    const leaf = code("\n".repeat(140_000));
    const document = authored({
      type: "root",
      children: [
        {
          type: "list",
          ordered: true,
          start: 999,
          children: [{ type: "listItem", children: [{ type: "blockquote", children: [leaf] }] }],
        },
      ],
    });
    const written = writeDocument(document);
    expect(written.length).toBeLessThanOrEqual(1_000_000);
    expect(parsed(written).children[0]).toMatchObject({ type: "list" });
  }, 15_000);
});

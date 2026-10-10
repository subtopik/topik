import type { Root } from "mdast";
import { describe, expect, test, vi } from "vite-plus/test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { directiveToMarkdown } from "mdast-util-directive";
import { gfm } from "micromark-extension-gfm";
import { tagFromMarkdown, tagSyntax, tagToMarkdown, TagSyntaxError } from "./index.js";
import { meaning } from "./test-support.js";

const declarations = {
  panel: { kind: "block" },
  codeTab: { kind: "block" },
  badge: { kind: "inline" },
} as const;
const options = { expressions: true };
const sparsePath: string[] = [];
sparsePath.length = 1;

function parse(source: string, tags = declarations): Root {
  return fromMarkdown(source, {
    extensions: [gfm(), tagSyntax(tags, options)],
    mdastExtensions: [...gfmFromMarkdown(), tagFromMarkdown(tags, options)],
  });
}

function write(tree: Root, tags = declarations): string {
  return toMarkdown(tree, { extensions: [gfmToMarkdown(), tagToMarkdown(tags, options)] });
}

function code(payload: string, header = "sh", fence = "```"): string {
  return `{% template code %}\n${fence}${header}\n${payload}\n${fence}\n{% /template code %}`;
}

describe("explicit text templates", () => {
  test("retains whole, mixed, empty and literal-only attribute templates", () => {
    const source =
      '{% badge empty=t"" literal=t"fixed" mixed=t"Install {% $package.name %}" whole=t"{% $version %}" /%}';
    expect(parse(source).children[0]).toMatchObject({
      children: [
        {
          attributes: {
            empty: { type: "topikTextTemplate", segments: [] },
            literal: { type: "topikTextTemplate", segments: [{ type: "literal", value: "fixed" }] },
            mixed: {
              type: "topikTextTemplate",
              segments: [
                { type: "literal", value: "Install " },
                { type: "variable", path: ["package", "name"] },
              ],
            },
            whole: {
              type: "topikTextTemplate",
              segments: [{ type: "variable", path: ["version"] }],
            },
          },
        },
      ],
    });
    const output = write(parse(source));
    expect(meaning(parse(output))).toEqual(meaning(parse(source)));
    expect(write(parse(output))).toBe(output);
  });

  test("unescapes quotes separately and consumes escaped openers exactly once", () => {
    const source = String.raw`{% badge label=t"Quote \" {%% $literal %}; {%%%; \\{% $active %}" /%}`;
    expect(parse(source).children[0]).toMatchObject({
      children: [
        {
          attributes: {
            label: {
              type: "topikTextTemplate",
              segments: [
                { type: "literal", value: 'Quote " {% $literal %}; {%%; \\' },
                { type: "variable", path: ["active"] },
              ],
            },
          },
        },
      ],
    });
    expect(meaning(parse(write(parse(source))))).toEqual(meaning(parse(source)));
  });

  test("ordinary attributes and all ordinary code stay literal", () => {
    const source =
      '{% badge label="{% $name %} {%%" /%}\n\n`{% $name %}`\n\n```sh\n{% $name %}\n```';
    expect(parse(source).children[0]).toMatchObject({
      children: [{ attributes: { label: "{% $name %} {%%" } }],
    });
    expect(parse(source).children[2]).toMatchObject({ type: "code", value: "{% $name %}" });
  });

  test.each(["{% $bad.__proto__ %}", "{% $missing", "{% badge /%}", "{% $a[0] %}", "{% $a\n%}"])(
    "refuses malformed template token %j",
    (token) => {
      expect(() => parse(`{% badge label=t"${token}" /%}`)).toThrow(TagSyntaxError);
    },
  );

  test("does not enable attribute templates without expressions", () => {
    expect(() =>
      fromMarkdown('{% badge label=t"{% $name %}" /%}', {
        extensions: [tagSyntax(declarations)],
        mdastExtensions: [tagFromMarkdown(declarations)],
      }),
    ).toThrow(TagSyntaxError);
  });

  test("reports literal attribute controls with a stable template diagnostic", () => {
    try {
      parse('{% badge label=t"A\tB" /%}');
      throw new Error("Expected a template control diagnostic");
    } catch (error) {
      expect(error).toBeInstanceOf(TagSyntaxError);
      expect((error as TagSyntaxError).diagnostics).toContainEqual(
        expect.objectContaining({ id: "topik-template-control" }),
      );
    }
  });
});

describe("explicit fenced code templates", () => {
  test.each(["```", "~~~"])(
    "retains segmented code with %s fences and unchanged backslashes",
    (fence) => {
      const payload = String.raw`C:\Users\{% $user.name %}\Documents
const pattern = /\\d+/;
{%% $literal %} {%%%`;
      const source = code(payload, "sh copy", fence);
      expect(parse(source).children[0]).toMatchObject({
        type: "tagCodeTemplate",
        lang: "sh",
        meta: "copy",
        template: {
          type: "topikTextTemplate",
          segments: [
            { type: "literal", value: "C:\\Users\\" },
            { type: "variable", path: ["user", "name"] },
            {
              type: "literal",
              value: String.raw`\Documents
const pattern = /\\d+/;
{% $literal %} {%%`,
            },
          ],
        },
      });
      const output = write(parse(source));
      expect(meaning(parse(output))).toEqual(meaning(parse(source)));
      expect(write(parse(output))).toBe(output);
    },
  );

  test.each(["text&#x20;lang", "text &#xA;", "text &#xD;"])(
    "refuses decoded controls and language separators in code headers %j",
    (header) => {
      try {
        parse(code("x", header, "~~~"));
        throw new Error("Expected a code-template header diagnostic");
      } catch (error) {
        expect(error).toBeInstanceOf(TagSyntaxError);
        expect((error as TagSyntaxError).diagnostics).toContainEqual(
          expect.objectContaining({ id: "topik-code-template-structure" }),
        );
      }
    },
  );

  test.each([
    (body: string) => `{% panel %}\n${body}\n{% /panel %}`,
    (body: string) => `{% codeTab %}\n${body}\n{% /codeTab %}`,
    (body: string) => `{% if $show %}\n${body}\n{% else /%}\n${code("{%% $other %}")}\n{% /if %}`,
    (body: string) => `- ${body.replaceAll("\n", "\n  ")}\n- next`,
    (body: string) =>
      body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
  ])("pairs only within a logical parent %#", (wrap) => {
    const source = wrap(code("{% $name %}"));
    const output = write(parse(source));
    expect(meaning(parse(output))).toEqual(meaning(parse(source)));
    expect(write(parse(output))).toBe(output);
  });

  test.each([
    "{% template code %}\n{% /template code %}",
    "{% template code %}\n    indented\n{% /template code %}",
    "{% template code %}\nprose\n{% /template code %}",
    "{% template code %}\n```sh\nx\n```\n```sh\ny\n```\n{% /template code %}",
    "{% template code %}\n```sh\nx\n{% /template code %}",
    "{% template code %}\n```sh\nx\n~~~\n{% /template code %}",
    code("x", "mermaid"),
    "{% template code /%}\n```sh\nx\n```",
    `{% template code %}\n${code("x")}\n{% /template code %}`,
    "- {% template code %}\n  ```sh\n  x\n  ```\n- {% /template code %}",
    "{% template code %}\n{% if $show %}\n```sh\nx\n```\n{% /if %}\n{% /template code %}",
    "{% if $show %}\n{% template code %}\n```sh\nx\n```\n{% else /%}\n{% /template code %}\n{% /if %}",
  ])("refuses invalid code-template scope %#", (source) => {
    expect(() => parse(source)).toThrow(TagSyntaxError);
  });

  test("preserves custom template and codeTemplate names including standalone inline template", () => {
    const tags = {
      ...declarations,
      template: { kind: "inline" },
      codeTemplate: { kind: "block" },
    } as const;
    const source =
      "before\n{% template %}inline{% /template %}\nafter\n\n{% codeTemplate %}\ntext\n{% /codeTemplate %}\n\n" +
      code("{% $name %}");
    const output = write(parse(source, tags), tags);
    expect(meaning(parse(output, tags))).toEqual(meaning(parse(source, tags)));
  });

  test.each([
    "{% /template code %}",
    "{% template code %}\n```sh\nx\n```",
    "{% template code %}\n```sh\nx\n{% /template code %}",
    "{% template code %}\n```sh\nx\n```\n{% /panel %}",
    "{% if $show %}\n{% template code %}\n```sh\nx\n```\n{% else /%}\n{% /template code %}\n{% /if %}",
    "- {% template code %}\n  ```sh\n  x\n  ```\n- {% /template code %}",
  ])("reports missing/cross-boundary terminators as scope diagnostics %#", (source) => {
    try {
      parse(source);
      throw new Error("Expected a code-template scope diagnostic");
    } catch (error) {
      expect(error).toBeInstanceOf(TagSyntaxError);
      expect((error as TagSyntaxError).diagnostics).toContainEqual(
        expect.objectContaining({ id: "topik-code-template-structure" }),
      );
    }
  });
});

describe("caller-built template serialization", () => {
  test.each(["plain", "template"])(
    "refuses %s attribute value accessors without invoking them",
    (kind) => {
      let calls = 0;
      const attributes = {};
      Object.defineProperty(attributes, "label", {
        enumerable: true,
        get() {
          calls++;
          return kind === "plain" ? "literal" : { type: "topikTextTemplate", segments: [] };
        },
      });
      const tree = {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "tagText",
                name: "badge",
                children: [],
                attributes,
              },
            ],
          },
        ],
      } as unknown as Root;
      expect(() => write(tree)).toThrow(/attributes/);
      expect(calls).toBe(0);
    },
  );

  test("refuses an attribute-map accessor without invoking it", () => {
    let calls = 0;
    const node = { type: "tagText", name: "badge", children: [] };
    Object.defineProperty(node, "attributes", {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });
    const tree = {
      type: "root",
      children: [{ type: "paragraph", children: [node] }],
    } as unknown as Root;
    expect(() => write(tree)).toThrow(/attributes/);
    expect(calls).toBe(0);
  });

  test.each([Object.create({ label: "inherited" }), new Map([["label", "executable"]])])(
    "refuses inherited or executable attribute-map prototypes %#",
    (attributes) => {
      const tree = {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "tagText",
                name: "badge",
                children: [],
                attributes,
              },
            ],
          },
        ],
      } as unknown as Root;
      expect(() => write(tree)).toThrow(/attributes/);
    },
  );

  test("refuses template quote expansion before allocating quoted output", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "tagText",
              name: "badge",
              children: [],
              attributes: {
                label: {
                  type: "topikTextTemplate",
                  segments: [{ type: "literal", value: "\\".repeat(600_000) }],
                },
              },
            },
          ],
        },
      ],
    } as unknown as Root;
    const replace = vi.spyOn(String.prototype, "replaceAll");
    try {
      expect(() => write(tree)).toThrow(/limit/);
      expect(replace.mock.calls.some(([search]) => search === "\\" || search === '"')).toBe(false);
    } finally {
      replace.mockRestore();
    }
  });

  test.each(["quote", "table pipe", "directive bracket"])(
    "includes %s escapes in the quoted template budget",
    (context) => {
      const unit = context === "quote" ? '"' : context === "table pipe" ? "|" : "[";
      const tag = {
        type: "tagText",
        name: "badge",
        children: [],
        attributes: {
          label: {
            type: "topikTextTemplate",
            segments: [{ type: "literal", value: unit.repeat(600_000) }],
          },
        },
      };
      const tree = {
        type: "root",
        children:
          context === "table pipe"
            ? [
                {
                  type: "table",
                  align: [null],
                  children: [
                    { type: "tableRow", children: [{ type: "tableCell", children: [tag] }] },
                  ],
                },
              ]
            : [
                {
                  type: "paragraph",
                  children:
                    context === "directive bracket"
                      ? [
                          {
                            type: "textDirective",
                            name: "note",
                            attributes: {},
                            children: [tag],
                          },
                        ]
                      : [tag],
                },
              ],
      } as unknown as Root;
      expect(() =>
        toMarkdown(tree, {
          extensions: [
            gfmToMarkdown(),
            directiveToMarkdown(),
            tagToMarkdown(declarations, options),
          ],
        }),
      ).toThrow(/limit/);
    },
  );

  test("accepts plain null-prototype attribute maps", () => {
    const attributes = Object.assign(Object.create(null), { label: "literal" });
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "tagText",
              name: "badge",
              children: [],
              attributes,
            },
          ],
        },
      ],
    } as unknown as Root;
    expect(write(tree)).toBe('{% badge label="literal" /%}\n');
  });

  test("refuses duplicate payload fields on code-template leaves", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "tagCodeTemplate",
          lang: "text",
          value: "alias",
          template: { type: "topikTextTemplate", segments: [] },
        },
      ],
    } as unknown as Root;
    expect(() => write(tree)).toThrow(/code template node/);
  });

  test.each(["lang", "meta", "template", "children"])(
    "refuses code-template field accessors without calling %s",
    (field) => {
      let calls = 0;
      const node = {
        type: "tagCodeTemplate",
        lang: "text",
        meta: null,
        template: { type: "topikTextTemplate", segments: [] },
      };
      Object.defineProperty(node, field, {
        enumerable: true,
        get() {
          calls++;
          return "value";
        },
      });
      const tree = { type: "root", children: [node] } as unknown as Root;
      expect(() => write(tree)).toThrow(/code template node/);
      expect(calls).toBe(0);
    },
  );

  test.each([
    { lang: "", meta: null },
    { lang: "text", meta: "" },
  ])("refuses unrepresentable empty code header fields %#", (header) => {
    const tree = {
      type: "root",
      children: [
        {
          type: "tagCodeTemplate",
          ...header,
          template: { type: "topikTextTemplate", segments: [] },
        },
      ],
    } as unknown as Root;
    expect(() => write(tree)).toThrow(/language or metadata/);
  });

  test("round trips bounded delimiter combinations and every split literal boundary", () => {
    const alphabet = ["{", "%", "}", "\\", '"', "|", "[", "]"];
    const values = ["", ...alphabet];
    for (const first of alphabet)
      for (const second of alphabet) {
        values.push(first + second);
        for (const third of alphabet) values.push(first + second + third);
      }
    for (const value of values) {
      const segments = [
        ...Array.from(value, (unit) => ({ type: "literal", value: unit })),
        { type: "literal", value: "" },
        { type: "variable", path: ["active"] },
        ...Array.from(value, (unit) => ({ type: "literal", value: unit })),
      ];
      const expected = [
        ...(value ? [{ type: "literal", value }] : []),
        { type: "variable", path: ["active"] },
        ...(value ? [{ type: "literal", value }] : []),
      ];
      const attribute = {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "tagText",
                name: "badge",
                children: [],
                attributes: {
                  label: { type: "topikTextTemplate", segments },
                },
              },
            ],
          },
        ],
      } as unknown as Root;
      const codeTree = {
        type: "root",
        children: [
          {
            type: "tagCodeTemplate",
            lang: null,
            meta: null,
            template: { type: "topikTextTemplate", segments },
          },
        ],
      } as unknown as Root;
      const attributeOutput = write(attribute);
      const codeOutput = write(codeTree);
      expect(parse(attributeOutput).children[0]).toMatchObject({
        children: [{ attributes: { label: { segments: expected } } }],
      });
      expect(parse(codeOutput).children[0]).toMatchObject({
        type: "tagCodeTemplate",
        template: { segments: expected },
      });
      expect(write(parse(attributeOutput))).toBe(attributeOutput);
      expect(write(parse(codeOutput))).toBe(codeOutput);
    }
  });

  test.each(["copy\tpath=C:\\temp &amp;", "copy&#x9;path=C:\\temp &amp;"])(
    "preserves literal metadata tabs and entities from %j",
    (meta) => {
      const source = code("{% $name %}", `text ${meta}`);
      const tree = parse(source);
      expect(tree.children[0]).toMatchObject({ meta: "copy\tpath=C:\\temp &" });
      const output = write(tree);
      expect(output).toContain("copy&#x9;path=C:&#x5C;temp &amp;");
      expect(meaning(parse(output))).toEqual(meaning(tree));
      expect(write(parse(output))).toBe(output);
    },
  );

  test("preserves entity-decoded leading metadata spaces", () => {
    const tree = parse(code("{% $name %}", "text &#x20; copy"));
    expect(tree.children[0]).toMatchObject({ meta: "  copy" });
    const output = write(tree);
    expect(meaning(parse(output))).toEqual(meaning(tree));
    expect(write(parse(output))).toBe(output);
  });

  test("refuses percent escape expansion before allocating encoded literal output", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "tagCodeTemplate",
          lang: "sh",
          meta: null,
          template: {
            type: "topikTextTemplate",
            segments: [{ type: "literal", value: "{%".repeat(340_000) }],
          },
        },
      ],
    } as unknown as Root;
    const replace = vi.spyOn(String.prototype, "replaceAll");
    try {
      expect(() => write(tree)).toThrow(/limit/);
      expect(replace).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
    }
  });

  test("refuses fence growth before allocating the repeated delimiter", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "tagCodeTemplate",
          lang: "sh",
          meta: null,
          template: {
            type: "topikTextTemplate",
            segments: [
              { type: "literal", value: "`".repeat(400_000) + "\n" + "~".repeat(400_000) },
            ],
          },
        },
      ],
    } as unknown as Root;
    const repeat = vi.spyOn(String.prototype, "repeat");
    try {
      expect(() => write(tree)).toThrow(/limit/);
      expect(repeat).not.toHaveBeenCalled();
    } finally {
      repeat.mockRestore();
    }
  });

  test.each([
    { type: "topikTextTemplate", segments: [{ type: "unknown", value: "x" }] },
    { type: "topikTextTemplate", segments: [{ type: "literal", value: "x", extra: true }] },
    { type: "topikTextTemplate", segments: [{ type: "variable", path: ["constructor"] }] },
    { type: "topikTextTemplate", segments: [{ type: "variable", path: sparsePath }] },
    { type: "topikTextTemplate", segments: [{ type: "literal", value: "a\nb" }] },
  ])("refuses malformed caller-built attributes %#", (template) => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "tagText",
              name: "badge",
              children: [],
              attributes: { label: template },
            },
          ],
        },
      ],
    } as unknown as Root;
    expect(() => write(tree)).toThrow();
  });

  test("does not invoke accessors in template segment arrays or paths", () => {
    let calls = 0;
    const segments: unknown[] = [];
    Object.defineProperty(segments, 0, {
      enumerable: true,
      get() {
        calls++;
        return { type: "literal", value: "x" };
      },
    });
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "tagText",
              name: "badge",
              children: [],
              attributes: { label: { type: "topikTextTemplate", segments } },
            },
          ],
        },
      ],
    } as unknown as Root;
    expect(() => write(tree)).toThrow();
    expect(calls).toBe(0);
  });

  test("counts template segments across code and attributes against the converted tree limit", () => {
    const variables = "{% $x %}".repeat(26_000);
    const source = `{% badge label=t"${variables}" /%}\n\n${code(variables)}`;
    expect(() => parse(source)).toThrow(TagSyntaxError);
  });

  test("merges split literal openers before escaping without mutating the input", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "tagText",
              name: "badge",
              children: [],
              attributes: {
                label: {
                  type: "topikTextTemplate",
                  segments: [
                    { type: "literal", value: "{" },
                    { type: "literal", value: "%" },
                    { type: "literal", value: " $literal %}" },
                    { type: "literal", value: "" },
                    { type: "variable", path: ["active"] },
                  ],
                },
              },
            },
          ],
        },
      ],
    } as unknown as Root;
    const original = structuredClone(tree);
    expect(write(tree)).toContain('label=t"{%% $literal %}{% $active %}"');
    expect(tree).toEqual(original);
    expect(parse(write(tree)).children[0]).toMatchObject({
      children: [
        {
          attributes: {
            label: {
              segments: [
                { type: "literal", value: "{% $literal %}" },
                { type: "variable", path: ["active"] },
              ],
            },
          },
        },
      ],
    });
  });

  test("chooses a fence longer than payload delimiters and retains literal-only code identity", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "tagCodeTemplate",
          lang: "sh",
          meta: null,
          template: {
            type: "topikTextTemplate",
            segments: [{ type: "literal", value: "```\n~~~\n{% $literal %}" }],
          },
        },
      ],
    } as unknown as Root;
    const output = write(tree);
    expect(parse(output).children[0]).toMatchObject({
      type: "tagCodeTemplate",
      template: {
        segments: [{ type: "literal", value: "```\n~~~\n{% $literal %}" }],
      },
    });
    expect(write(parse(output))).toBe(output);
  });

  test("does not feed long fences into host header escaping and preserves literal metadata", () => {
    const literal = "`".repeat(100_000) + "\n" + "~".repeat(100_000);
    const tree = {
      type: "root",
      children: [
        {
          type: "tagCodeTemplate",
          lang: "text",
          meta: String.raw`copy={% $literal %} path=C:\temp &amp;`,
          template: {
            type: "topikTextTemplate",
            segments: [
              { type: "literal", value: literal },
              { type: "variable", path: ["name"] },
            ],
          },
        },
      ],
    } as unknown as Root;
    const extension = tagToMarkdown(declarations, options);
    const handler = extension.handlers!.tagCodeTemplate!;
    const output = toMarkdown(tree, {
      extensions: [extension],
      handlers: {
        tagCodeTemplate(node, parent, state, info) {
          const safe = state.safe;
          state.safe = (value, config) => {
            expect(config.before?.length ?? 0).toBeLessThan(1000);
            return safe(value, config);
          };
          try {
            return handler(node, parent, state, info);
          } finally {
            state.safe = safe;
          }
        },
      },
    });
    expect(meaning(parse(output))).toEqual(meaning(tree));
    expect(write(parse(output))).toBe(output);
  });
});

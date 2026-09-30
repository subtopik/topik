import { describe, expect, test } from "vite-plus/test";
import { components, parseDocument, rewriteAssets, writeDocument, type Registry } from "./index.js";
import { withoutPositions, parse as parsed } from "./test-helpers.js";

function canonical(source: string): string {
  return writeDocument(parsed(source));
}

describe("independent Markdown meaning", () => {
  test("inline tags reflow inside one paragraph through source writing", () => {
    const source = 'Available on the\n{% badge variant="info" %}Pro{% /badge %}\nplan.';
    const document = parsed(source);
    expect(document.children).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "Available on the\n" },
          { type: "topikComponent", name: "badge", props: { variant: "info" } },
          { type: "text", value: "\nplan." },
        ],
      },
    ]);
    expect(withoutPositions(parsed(writeDocument(document)).children)).toEqual(
      withoutPositions(document.children),
    );
  });

  test("block tags retain tight list structure around sibling prose", () => {
    const source =
      '- Before\n  {% callout variant="info" %}\n  Hello {% badge variant="info" %}Pro{% /badge %}\n  {% /callout %}\n  After\n- Two';
    const document = parsed(source);
    const formatted = writeDocument(document);
    expect(withoutPositions(parsed(formatted).children)).toEqual(
      withoutPositions(document.children),
    );
    expect(writeDocument(parsed(formatted))).toBe(formatted);
  });

  test("inline tags inside reference links retain their target through source writing", () => {
    const source =
      '[See {% badge variant="info" %}Pro{% /badge %}][guide]\n\n[guide]: https://example.com ""';
    const document = parsed(source);
    expect(document.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        {
          type: "linkReference",
          children: [{ type: "text" }, { type: "topikComponent", name: "badge" }],
        },
      ],
    });
    expect(withoutPositions(parsed(writeDocument(document)).children)).toEqual(
      withoutPositions(document.children),
    );
  });

  test("escaped punctuation stays literal through source writing", () => {
    const doc = parsed(String.raw`Keep \*literal\* text.`);
    expect(doc.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "Keep *literal* text." }],
    });
    const output = writeDocument(doc);
    expect(output).toContain(String.raw`\*literal\*`);
    expect(parsed(output).children[0]).toMatchObject(doc.children[0]);
  });

  test("alignment, inline backtick payload, and fenced code payload survive", () => {
    const source =
      '| Price |\n| ---: |\n| 12 |\n\n``a`b``\n\n```txt\n{% callout variant="info" %}\n```';
    const doc = parsed(source);
    expect(doc.children[0]).toMatchObject({ type: "table", align: ["right"] });
    expect(doc.children[1]).toMatchObject({
      type: "paragraph",
      children: [{ type: "inlineCode", value: "a`b" }],
    });
    expect(doc.children[2]).toMatchObject({ type: "code", value: '{% callout variant="info" %}' });
    expect(withoutPositions(parsed(writeDocument(doc)).children)).toEqual(
      withoutPositions(doc.children),
    );
  });

  test("escaped quote, backslash and entity titles retain their values", () => {
    const source = String.raw`[link](https://example.com "say \"hi\" &amp; back\\slash") ![image](asset:logo "say \"hi\"")`;
    const doc = parsed(source);
    expect(doc.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "link", title: 'say "hi" & back\\slash' },
        { type: "text" },
        { type: "image", title: 'say "hi"' },
      ],
    });
    expect(withoutPositions(parsed(writeDocument(doc)).children)).toEqual(
      withoutPositions(doc.children),
    );
  });

  test("quoted, empty, and absent titles plus exact URLs survive", () => {
    const source = String.raw`![Demo](https://example.com/a(b).png?sig=Ab%2f&x=1&x=2 "say \"hi\"") [link](https://example.com/a(b)?token=Q%2f&x=1&x=2 "") ![None](asset:logo)`;
    const doc = parsed(source);
    expect(doc.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "image", url: "https://example.com/a(b).png?sig=Ab%2f&x=1&x=2", title: 'say "hi"' },
        { type: "text" },
        { type: "link", url: "https://example.com/a(b)?token=Q%2f&x=1&x=2", title: "" },
        { type: "text" },
        { type: "image", url: "asset:logo", title: null },
      ],
    });
    expect(withoutPositions(parsed(writeDocument(doc)).children[0])).toEqual(
      withoutPositions(doc.children[0]),
    );
  });

  test("empty titles remain present on both inline images and links", () => {
    const document = parsed('![Demo](image.png "") and [link](/guide "")');
    const expected = {
      type: "paragraph",
      children: [
        { type: "image", title: "" },
        { type: "text", value: " and " },
        { type: "link", title: "" },
      ],
    };
    expect(document.children[0]).toMatchObject(expected);
    expect(parsed(writeDocument(document)).children[0]).toMatchObject(expected);
  });

  test("reference identity and explicit empty definition title survive", () => {
    const source = '![Demo][asset]\n\n[asset]: https://example.com/a.png ""';
    const doc = parsed(source);
    expect(doc.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "imageReference", identifier: "asset" }],
    });
    expect(doc.children[1]).toMatchObject({
      type: "definition",
      identifier: "asset",
      url: "https://example.com/a.png",
      title: "",
    });
    expect(withoutPositions(parsed(writeDocument(doc)).children)).toEqual(
      withoutPositions(doc.children),
    );
    const rewritten = rewriteAssets(doc, (url) =>
      url.endsWith("a.png") ? "asset:new" : undefined,
    );
    expect(rewritten.children[1]).toMatchObject({
      type: "definition",
      url: "asset:new",
      title: "",
    });
  });

  test("shared image/link definition refuses a rewrite that would alter the link", () => {
    const doc = parsed("![Logo][asset] [Download][asset]\n\n[asset]: asset:old");
    expect(() =>
      rewriteAssets(doc, (url) => (url === "asset:old" ? "asset:new" : undefined)),
    ).toThrow("shared by an image and a link");
    expect(writeDocument(doc)).toContain("asset:old");
  });

  test("one link with mixed styling remains one link through source writing", () => {
    const source = '[before **bold** after](https://example.com "Title")';
    const doc = parsed(source);
    const roundTripped = parsed(writeDocument(doc));
    expect(roundTripped.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        {
          type: "link",
          children: [
            { type: "text", value: "before " },
            { type: "strong", children: [{ type: "text", value: "bold" }] },
            { type: "text", value: " after" },
          ],
        },
      ],
    });
    expect(writeDocument(roundTripped).match(/\]\(https/g)).toHaveLength(1);
    expect(withoutPositions(parsed(writeDocument(roundTripped)).children)).toEqual(
      withoutPositions(doc.children),
    );
  });

  test("adjacent equal links remain separate occurrences", () => {
    const source = "[A](https://example.com)[B](https://example.com)";
    const roundTripped = parsed(writeDocument(parsed(source)));
    expect(roundTripped.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "link", children: [{ type: "text", value: "A" }] },
        { type: "link", children: [{ type: "text", value: "B" }] },
      ],
    });
    expect(writeDocument(roundTripped).match(/\]\(https/g)).toHaveLength(2);
  });

  test("literal tag-looking text is escaped and formatting converges", () => {
    const once = canonical(String.raw`Keep \{% callout variant="info" %} and \{% $name %}.`);
    expect(once).toContain(String.raw`\{%`);
    expect(canonical(once)).toBe(once);
    expect(parsed(once).children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: 'Keep {% callout variant="info" %} and {% $name %}.' }],
    });
  });

  test("indented code and escaped tags stay literal", () => {
    const source = '    {% callout variant="info" %}\n\n\\{% badge text="Literal" tone="info" /%}';
    const doc = parsed(source);
    expect(doc.children).toMatchObject([
      { type: "code", value: '{% callout variant="info" %}' },
      {
        type: "paragraph",
        children: [{ type: "text", value: '{% badge text="Literal" tone="info" /%}' }],
      },
    ]);
    expect(withoutPositions(parsed(writeDocument(doc)).children)).toEqual(
      withoutPositions(doc.children),
    );
  });
});

describe("component source conversion", () => {
  const source =
    '{% callout variant="info" %}\n\nKeep **backup** {% badge variant="success" %}New{% /badge %}.\n\n{% tabs %}\n\n{% tab title="First" %}\n\n- One\n- Two\n\n{% /tab %}\n\n{% tab title="Second" %}\n\n> Quote\n\n{% /tab %}\n\n{% /tabs %}\n\n{% /callout %}';

  test("nested callouts, tabs, and badges serialize and reopen", () => {
    const doc = parsed(source);
    expect(doc.children[0]).toMatchObject({
      type: "topikComponent",
      name: "callout",
      props: { variant: "info" },
    });
    const output = writeDocument(doc);
    expect(withoutPositions(parsed(output).children)).toEqual(withoutPositions(doc.children));
    expect(canonical(output)).toBe(output);
  });

  test("block tags nest in list items and quotes", () => {
    const source =
      '- Intro\n\n  {% callout variant="warning" %}\n\n  Detail\n\n  {% /callout %}\n\n> {% callout variant="info" %}\n>\n> Quote\n>\n> {% /callout %}';
    const doc = parsed(source);
    expect(doc.children[0]).toMatchObject({
      type: "list",
      children: [
        {
          type: "listItem",
          children: [{ type: "paragraph" }, { type: "topikComponent", name: "callout" }],
        },
      ],
    });
    expect(doc.children[1]).toMatchObject({
      type: "blockquote",
      children: [{ type: "topikComponent", name: "callout" }],
    });
    expect(withoutPositions(parsed(writeDocument(doc)).children)).toEqual(
      withoutPositions(doc.children),
    );
  });

  test("asset rewrite changes image identity without changing prose", () => {
    const doc = parsed('Use asset:logo in prose. ![Logo](asset:logo "")');
    const changed = rewriteAssets(doc, (url) =>
      url === "asset:logo" ? "asset:new-logo" : undefined,
    );
    expect(parsed(writeDocument(changed)).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "Use asset:logo in prose. " },
        { type: "image", url: "asset:new-logo", title: "" },
      ],
    });
  });

  test("registered custom component uses its schema and asset declaration", () => {
    const registry: Registry = {
      ...components,
      media: {
        kind: "inline",
        attributes: { src: { type: "string", required: true, asset: true } },
        children: "none",
        render: false,
      },
    };
    const result = parseDocument('A {% media src="asset:old" /%}.', registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rewritten = rewriteAssets(
      result.document,
      (url) => (url === "asset:old" ? "asset:new" : undefined),
      registry,
    );
    expect(writeDocument(rewritten, registry)).toContain('{% media src="asset:new" /%}');
    expect(parseDocument('A {% media other="x" /%}.', registry)).toMatchObject({ ok: false });
  });

  test("writer refuses control characters in component attributes", () => {
    for (const value of ["line\nbreak", "tab\tvalue", "nul\0value"]) {
      const doc = parsed('{% badge variant="info" %}Safe{% /badge %}');
      const badge = (doc.children[0] as { children: Array<{ props: Record<string, string> }> })
        .children[0];
      badge.props.variant = value;
      expect(() => writeDocument(doc)).toThrow("Control character");
    }
  });

  test("prototype names and non-string properties produce diagnostics", () => {
    const source = "{% constructor /%}";
    expect(parseDocument(source)).toMatchObject({
      ok: false,
      source,
      diagnostics: [{ message: "Unknown component constructor" }],
    });
    expect(
      parseDocument('{% callout variant="info" constructor="extra" %}\n\nText\n\n{% /callout %}'),
    ).toMatchObject({ ok: false });
    const doc = parsed('{% badge variant="info" %}Safe{% /badge %}');
    const badge = (doc.children[0] as { children: Array<{ props: Record<string, unknown> }> })
      .children[0];
    badge.props.variant = 42;
    expect(() => writeDocument(doc)).toThrow("must be a string");
  });

  test("empty paragraphs explicitly refuse source writing", () => {
    const document = parsed("Text");
    document.children.unshift({ type: "paragraph", children: [] });
    expect(() => writeDocument(document)).toThrow(
      "Empty paragraphs have no faithful Markdown representation",
    );
    expect(writeDocument(parsed("Text"))).toBe("Text\n");
  });
});

describe("explicit refusal with raw source", () => {
  test.each([
    ["unknown tag", "{% mystery /%}"],
    ["unknown attr", '{% callout variant="info" extra="x" %}\n\nText\n\n{% /callout %}'],
    ["mismatched tag", '{% callout variant="info" %}\n\nText\n\n{% /tabs %}'],
    ["unclosed tag", '{% callout variant="info" %}\n\nText'],
    ["unsupported expression syntax", "{% $name + 1 %}"],
    ["expression attribute", '{% badge text={name} tone="info" /%}'],
    ["raw HTML", "<script>alert(1)</script>"],
    ["footnote", "Note[^a]\n\n[^a]: Value"],
    ["block inline", 'Text {% callout variant="info" %}'],
    ["unterminated tag", '{% callout variant="info"'],
  ])("refuses %s", (_label, source) => {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics[0].message).toBeTruthy();
  });

  test("unknown format version is refused before conversion", () => {
    const source = "Hello";
    expect(parseDocument(source, components, 2)).toMatchObject({
      ok: false,
      source,
      diagnostics: [{ message: "Unsupported format version 2" }],
    });
    expect(() => writeDocument(parsed(source), components, 2)).toThrow(
      "Unsupported format version 2",
    );
  });
});

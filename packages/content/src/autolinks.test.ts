import { describe, expect, test } from "vite-plus/test";
import {
  analyzeTopikContent,
  extractTopikAssetOccurrences,
  formatTopikContent,
  parseDocument,
  transformTopikContent,
  validateTopikContent,
  writeDocument,
  type ContentDocument,
} from "./index.js";
import { parse, withoutPositions } from "./test-helpers.js";

describe("explicit link intent", () => {
  test.each([
    "https://example.test/path",
    "http://example.test/path",
    "www.example.com",
    "person@example.com",
    "mailto:person@example.com",
  ])("keeps bare addresses as text through source admission and round trips: %s", (value) => {
    const source = `${value}\n`;
    const expected: ContentDocument = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value }] }],
    };
    const document = parse(source);
    // Assert author intent independently of the parser's own interpretation.
    expect(withoutPositions(document)).toEqual(expected);
    expect(validateTopikContent(source).valid).toBe(true);
    expect(analyzeTopikContent(source).links).toEqual([]);
    expect(extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true })).toEqual(
      [],
    );
    expect(transformTopikContent(document)).toMatchObject({
      name: "article",
      children: [{ name: "p", children: [value] }],
    });
    expect(writeDocument(document)).toBe(source);
    expect(withoutPositions(parse(writeDocument(expected)))).toEqual(expected);
    expect(formatTopikContent(source)).toMatchObject({ ok: true, formatted: source });
  });
});

function urls(document: ContentDocument): string[] {
  const result: string[] = [];
  function visit(node: { type: string; url?: string; children?: unknown[] }): void {
    if (node.type === "link") result.push(node.url!);
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  }
  visit(document);
  return result;
}

describe("link parser resource use", () => {
  test.each([false, true])(
    "bounds parsing a long URL (explicit: %s)",
    (explicit) => {
      const url = "https://example.test/" + "*".repeat(40_000) + "end";
      const source = explicit ? `<${url}>` : url;
      const start = performance.now();
      const result = parseDocument(source);
      const elapsed = performance.now() - start;
      expect(result.ok).toBe(true);
      if (result.ok) expect(urls(result.document)).toEqual(explicit ? [url] : []);
      expect(elapsed).toBeLessThan(1_000);
    },
    30_000,
  );

  test("does not repeatedly scan the document after an unclosed label", () => {
    const source = "[ " + "Read http then ask member@office for more notes. ".repeat(6_000);
    const start = performance.now();
    const result = parseDocument(source);
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(urls(result.document)).toEqual([]);
      expect(result.document.children).toMatchObject([
        { type: "paragraph", children: [{ type: "text", value: source.trimEnd() }] },
      ]);
    }
    expect(elapsed).toBeLessThan(1_000);
  }, 30_000);

  test.each([
    "mailto:" + "a".repeat(80_000) + "@example.test",
    "@".repeat(80_000) + "example.test",
    "https://host" + ".".repeat(80_000) + "test",
  ])("bounds parsing long address-like text %#", (source) => {
    const start = performance.now();
    const document = parse(source);
    expect(urls(document)).toEqual([]);
    expect(document.children).toMatchObject([
      { type: "paragraph", children: [{ type: "text", value: source }] },
    ]);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  test("enforces content limits for repeated explicit links", () => {
    const source = "<a@b.co> ".repeat(18_000);
    expect(parseDocument(source)).toMatchObject({
      ok: false,
      source,
      diagnostics: [{ id: "topik-content-limit" }],
    });
  });
});

describe("explicit Markdown links", () => {
  test.each([
    ["<https://example.test/path>", "https://example.test/path", "https://example.test/path"],
    ["<person@example.com>", "mailto:person@example.com", "person@example.com"],
    ["<mailto:person@example.com>", "mailto:person@example.com", "mailto:person@example.com"],
    ["[Website](https://www.example.com)", "https://www.example.com", "Website"],
    ["[Email](mailto:person@example.com)", "mailto:person@example.com", "Email"],
    ["<https://example.test/a*b*c>", "https://example.test/a*b*c", "https://example.test/a*b*c"],
  ])("parses the declared destination and label: %s", (source, url, label) => {
    const expected: ContentDocument = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url,
              title: null,
              children: [{ type: "text", value: label }],
            },
          ],
        },
      ],
    };
    const document = parse(source);
    expect(withoutPositions(document)).toEqual(expected);
    expect(validateTopikContent(source).valid).toBe(true);
    expect(analyzeTopikContent(source).links).toMatchObject([{ href: url }]);
    const written = writeDocument(document);
    expect(withoutPositions(parse(written))).toEqual(expected);
    expect(writeDocument(parse(written))).toBe(written);
  });

  test("preserves reference links and their destinations", () => {
    const source = "[Guide][docs]\n\n[docs]: https://example.test/guide\n";
    const document = parse(source);
    expect(document.children).toMatchObject([
      { type: "paragraph", children: [{ type: "linkReference", identifier: "docs" }] },
      { type: "definition", identifier: "docs", url: "https://example.test/guide" },
    ]);
    expect(analyzeTopikContent(source).links).toMatchObject([
      { href: "https://example.test/guide" },
    ]);
    expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
  });

  test("removing a link leaves text unlinked after writing and reopening", () => {
    const document = parse("[www.example.com](https://www.example.com)");
    const paragraph = document.children[0];
    if (paragraph.type !== "paragraph" || paragraph.children[0].type !== "link")
      throw new Error("Expected an explicit link");
    paragraph.children = paragraph.children[0].children;
    const source = writeDocument(document);
    expect(source).toBe("www.example.com\n");
    expect(withoutPositions(parse(source))).toEqual({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "www.example.com" }] }],
    });
  });

  test("Markdown formatting in a bare URL remains ordinary text and marks", () => {
    const document = parse("https://example.test/a*b*c");
    expect(withoutPositions(document)).toEqual({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "https://example.test/a" },
            { type: "emphasis", children: [{ type: "text", value: "b" }] },
            { type: "text", value: "c" },
          ],
        },
      ],
    });
    expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
  });

  test.each([
    ["https://example.test/a***end", []],
    ["(https://example.test/a(b)).", []],
    ["https://example.test/a&amp;b", []],
    [
      "[**Guide**](https://docs.example.test)https://assets.example.test/file]",
      ["https://docs.example.test"],
    ],
    ["![Logo](https://assets.example.test/logo.png)https://assets.example.test/file", []],
    ["[Pending https://docs.example.test/start", []],
    ["`<https://example.test>`", []],
    ["[https://example.test](https://docs.example.test)", ["https://docs.example.test"]],
    ["_https://example.test/path_ **person@example.com** ~~www.example.com~~", []],
    ["**<https://example.test>**", ["https://example.test"]],
    ["`foo`bar@example.com", []],
    ["[foo](guide.md)bar@example.com", ["guide.md"]],
    ["https://example.test/a|b", []],
    ["HTTPS://example.test/path", []],
    ["example.com 1.2.3.4 ftp://example.com //example.com", []],
    ["https://例え.jp/道 https://[2001:db8::1]/path", []],
    [
      "<https://例え.jp/道> <https://[2001:db8::1]/path>",
      ["https://例え.jp/道", "https://[2001:db8::1]/path"],
    ],
    ["---\nurl: https://hidden.test\n---\n\nhttps://shown.test", []],
    ["```txt\nhttps://hidden.test\n```\n\nhttps://shown.test", []],
    ["{% badge %}https://example.test{% /badge %}", []],
    ["{% if $show %}\nhttps://a.test\n{% else /%}\nhttps://b.test\n{% /if %}", []],
    ["| First | Second |\n| --- | --- |\n|https://a.test/path|https://b.test/path|", []],
  ])("preserves the declared links and canonical output: %s", (source, expected) => {
    const document = parse(source);
    expect(urls(document)).toEqual(expected);
    const written = writeDocument(document);
    expect(withoutPositions(parse(written))).toEqual(withoutPositions(document));
    expect(writeDocument(parse(written))).toBe(written);
  });

  test("retains explicit link offsets after Unicode, entities, and container prefixes", () => {
    const source = "> 😀 &amp; text\n> <https://example.test/file.pdf>";
    expect(parse(source).children[0]).toMatchObject({
      children: [
        {
          children: [
            { type: "text", value: "😀 & text\n" },
            {
              type: "link",
              url: "https://example.test/file.pdf",
              position: {
                start: { line: 2, column: 3, offset: source.indexOf("<") },
                end: { line: 2, column: 34, offset: source.length },
              },
            },
          ],
        },
      ],
    });
    expect(
      extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true }),
    ).toMatchObject([
      {
        kind: "external-https",
        reference: "https://example.test/file.pdf",
        parsedReference: "https://example.test/file.pdf",
      },
    ]);
  });

  test.each(["http://example.test/file", "https://user:secret@example.test/file"])(
    "validates an explicit destination while allowing the same spelling as plain text: %s",
    (url) => {
      expect(urls(parse(url))).toEqual([]);
      expect(validateTopikContent(url).valid).toBe(true);
      for (const source of [`<${url}>`, `[Example](${url})`]) {
        expect(urls(parse(source))).toEqual([url]);
        expect(validateTopikContent(source).valid).toBe(false);
        expect(formatTopikContent(source)).toMatchObject({ ok: false, source });
      }
    },
  );
});

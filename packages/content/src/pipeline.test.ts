import { describe, expect, test } from "vite-plus/test";
import {
  formatTopikContent,
  parseTopikContent,
  rewriteTopikAssetOccurrences,
  transformTopikContent,
  validateDocument,
  writeDocument,
} from "./index.js";

describe("public content pipeline regressions", () => {
  test.each([
    '[Demo](/guide "a&#10;&#10;b")',
    '![Demo](image.png "a&#10;&#10;b")',
    '![Demo][image]\n\n[image]: image.png "a&#10;&#10;b"',
    '| Image |\n| --- |\n| ![Demo](image.png "a&#10;&#10;b") |',
  ])("preserves resources with title line breaks: %s", (source) => {
    const result = formatTopikContent(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected formatted content");
    const before = transformTopikContent(parseTopikContent(source));
    expect(transformTopikContent(parseTopikContent(result.formatted))).toEqual(before);
    expect(formatTopikContent(result.formatted)).toMatchObject({ formatted: result.formatted });
  });

  test("asset rewriting retains line breaks in a reference title", () => {
    const source = '![Demo][image]\n\n[image]: image.png "a&#10;&#10;b"';
    const result = rewriteTopikAssetOccurrences(source, () => "new.png");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected rewritten content");
    expect(parseTopikContent(result.content).children[0]).toMatchObject({
      children: [{ type: "image", url: "new.png", title: "a\n\nb" }],
    });
  });

  test.each([
    "[Demo](https://example.com/?x=1&y=2)",
    "![Demo](https://example.com/a(b).png)",
    "![Demo][id]\n\n[id]: https://example.com/a(b).png?x=1&y=2",
    "<https://example.com/a&copy;b>",
  ])("formatting retains admitted URL identity: %s", (source) => {
    const first = formatTopikContent(source);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected accepted input");
    const second = formatTopikContent(first.formatted);
    expect(second).toMatchObject({ ok: true, formatted: first.formatted });
    expect(transformTopikContent(parseTopikContent(first.formatted))).toEqual(
      transformTopikContent(parseTopikContent(source)),
    );
  });

  test("asset rewriting preserves the target used by each conditional branch", () => {
    const source = [
      "{% if $flag %}",
      "![Teacher][a]",
      "",
      "[a]: teacher.png",
      "{% else /%}",
      "![Student][a]",
      "",
      "[a]: student.png",
      "{% /if %}",
    ].join("\n");
    const seen: string[] = [];
    const result = rewriteTopikAssetOccurrences(source, (occurrence) => {
      seen.push(occurrence.reference);
      return `compiled-${occurrence.reference}`;
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["teacher.png", "student.png"]);
    if (!result.ok) throw new Error("Expected rewritten content");
    expect(
      transformTopikContent(parseTopikContent(result.content), { variables: { flag: false } }),
    ).toMatchObject({
      children: [{ children: [{ attributes: { src: "compiled-student.png" } }] }, null],
    });
  });

  test("refuses dangling references before a write can turn them into text", () => {
    const document = parseTopikContent("![Logo][logo]\n\n[logo]: logo.png");
    document.children.pop();
    expect(validateDocument(document).length).toBeGreaterThan(0);
    expect(() => writeDocument(document)).toThrow(/definition/);
  });

  test.each(["- one\n\n- two", "- one\n\n  continuation\n- two"])(
    "renders paragraph wrappers throughout a loose list: %s",
    (source) => {
      expect(transformTopikContent(parseTopikContent(source))).toMatchObject({
        children: [
          {
            name: "ul",
            children: [
              {
                name: "li",
                children: expect.arrayContaining([
                  { name: "p", attributes: {}, children: ["one"], type: "element" },
                ]),
              },
              { name: "li", children: [{ name: "p", children: ["two"] }] },
            ],
          },
        ],
      });
    },
  );

  test("formatting refuses excess table cells while preserving source", () => {
    const source = "| a |\n| - |\n| b | c |";
    const formatted = formatTopikContent(source);
    expect(formatted).toMatchObject({ ok: false, source });
    expect(formatted).not.toHaveProperty("formatted");
    expect(rewriteTopikAssetOccurrences(source, () => "new.png")).toMatchObject({
      ok: false,
      source,
    });
  });
});

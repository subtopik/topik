import { describe, expect, test } from "vite-plus/test";
import {
  extractTopikAssetOccurrences,
  formatTopikContent,
  parseTopikContent,
  rewriteTopikAssetOccurrences,
  transformTopikContent,
  validateTopikContent,
} from "./index.js";
import { withoutPositions } from "./test-helpers.js";

describe.each(["\r\n", "\r"])("source line endings %j", (ending) => {
  test.each([
    "First line\nsecond line",
    "```txt\nfirst\nsecond\n```",
    "    first\n    second",
    "---\ntitle: Test\ndescription: Example\n---\nBody",
    "> first\n> second",
    '![Image][id]\n\n[id]: image.png "first\nsecond"',
    "{% callout %}\nFirst\nsecond\n{% /callout %}",
  ])("preserves the meaning and formatting of %s", (lf) => {
    const source = lf.replaceAll("\n", ending);
    expect(validateTopikContent(source).valid).toBe(true);
    const document = parseTopikContent(source);
    expect(withoutPositions(document)).toEqual(withoutPositions(parseTopikContent(lf)));
    expect(transformTopikContent(document)).toEqual(transformTopikContent(parseTopikContent(lf)));
    const expected = formatTopikContent(lf);
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error("Expected supported Markdown");
    expect(formatTopikContent(source)).toMatchObject({
      ok: true,
      source,
      formatted: expected.formatted,
    });
  });

  test("retains original offsets and asset identity during rewriting", () => {
    const source = ["First", "second", "", "![Image](image.png)", ""].join(ending);
    const document = parseTopikContent(source);
    const paragraph = document.children[1];
    if (paragraph.type !== "paragraph") throw new Error("Expected image paragraph");
    const image = paragraph.children[0];
    expect(image.position).toEqual({
      start: { line: 4, column: 1, offset: source.indexOf("![") },
      end: { line: 4, column: 20, offset: source.lastIndexOf(ending) },
    });
    expect(document.position?.end.offset).toBe(source.length);
    expect(extractTopikAssetOccurrences(source)).toMatchObject([{ reference: "image.png" }]);
    expect(rewriteTopikAssetOccurrences(source, () => "new.png")).toMatchObject({
      ok: true,
      source,
      content: "First\nsecond\n\n![Image](new.png)\n",
    });
  });

  test("retains the exact source and diagnostic line on failure", () => {
    const source = ["First", "second", "", "[Unsafe](javascript:alert(1))"].join(ending);
    expect(formatTopikContent(source)).toMatchObject({
      ok: false,
      source,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "link-scheme-unsafe", lines: [4] }),
      ]),
    });
  });
});

test("does not normalize carriage returns decoded from character references", () => {
  expect(validateTopikContent("Text&#13;more").valid).toBe(false);
});

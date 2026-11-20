import { describe, expect, test } from "vite-plus/test";
import { parseDocument } from "./markdown.js";
import { sameDocumentMeaning } from "./document-meaning.js";
import { formatTopikContent } from "./format.js";
import { compileTopikContent } from "./compile.js";
import { validateTopikContent } from "./validate.js";
import { rewriteTopikAssetOccurrences } from "./rewrite.js";
import { rewriteTopikNavigationReferences } from "./navigation-rewrite.js";
import { extractTopikAssetOccurrences } from "./asset-references.js";
import { analyzeTopikContent } from "./links.js";

function roundtrip(source: string): void {
  expect(validateTopikContent(source).valid).toBe(true);
  const formatted = formatTopikContent(source);
  expect(formatted.ok).toBe(true);
  if (!formatted.ok) throw new Error("Formatting failed");
  const before = parseDocument(source);
  const after = parseDocument(formatted.formatted);
  if (!before.ok || !after.ok) throw new Error("Parsing failed");
  expect(sameDocumentMeaning(before.document, after.document)).toBe(true);
  expect(formatTopikContent(formatted.formatted)).toMatchObject({
    ok: true,
    formatted: formatted.formatted,
  });
}

describe("image alt and reference writer boundaries", () => {
  test.each(["&#10;", "&#10;&#10;", "&NewLine;&NewLine;", "&#10; &#10;"])(
    "preserves alt line feeds %s through asset rewriting",
    (newline) => {
      for (const reference of [false, true])
        for (const table of [false, true]) {
          const image = `![before${newline}after]${reference ? "[photo]" : "(./photo.png)"}`;
          const source = `${table ? `| Image |\n|---|\n| ${image} |` : image}${reference ? "\n\n[photo]: ./photo.png" : ""}`;
          roundtrip(source);
          const original = extractTopikAssetOccurrences(source);
          const rewritten = rewriteTopikAssetOccurrences(
            source,
            () => "https://example.com/photo.png",
          );
          expect(rewritten.ok, JSON.stringify({ source, rewritten })).toBe(true);
          if (!rewritten.ok) throw new Error("Asset rewrite failed");
          const assets = extractTopikAssetOccurrences(rewritten.content);
          expect(assets).toHaveLength(1);
          expect(assets[0].semantics).toEqual(original[0].semantics);
          expect(assets[0].reference).toBe("https://example.com/photo.png");
        }
    },
  );

  test.each([1, 3, 5])("preserves pipe identity after %i backslashes", (slashes) => {
    const label = `a${"\\".repeat(slashes)}|b`;
    for (const image of [false, true])
      for (const form of ["full", "collapsed", "shortcut"])
        for (const table of [false, true]) {
          const reference = `${image ? "!" : ""}[${form === "full" ? "label" : label}]${form === "full" ? `[${label}]` : form === "collapsed" ? "[]" : ""}`;
          const source = `[${label}]: ./next.png\n\n${table ? `| Heading |\n|---|\n| ${reference} |` : reference}`;
          roundtrip(source);
          if (image) {
            const rewritten = rewriteTopikAssetOccurrences(
              source,
              () => "https://example.com/next.png",
            );
            expect(rewritten.ok, JSON.stringify({ source, rewritten })).toBe(true);
            if (rewritten.ok)
              expect(extractTopikAssetOccurrences(rewritten.content)[0].reference).toBe(
                "https://example.com/next.png",
              );
          } else {
            const rewritten = rewriteTopikNavigationReferences(source, () => "/next");
            expect(rewritten.ok, JSON.stringify({ source, rewritten })).toBe(true);
            if (rewritten.ok)
              expect(analyzeTopikContent(rewritten.content).links[0].href).toBe("/next");
          }
        }
  });

  test.each([0, 2, 4])("retains raw/even pipe controls with %i backslashes", (slashes) => {
    const label = `a${"\\".repeat(slashes)}|b`;
    roundtrip(`[${label}]: /next\n\n[label][${label}]`);
    const source = `[${label}]: /next\n\n| Heading |\n|---|\n| [label][${label}] |`;
    expect(validateTopikContent(source).valid).toBe(false);
    expect(formatTopikContent(source)).toMatchObject({ ok: false, source });
  });
});

describe("block and inline writer boundaries", () => {
  test.each([
    // Inside a quote, a list keeps the blank line before a following container.
    "> - a\n> > b",
    "> 1. a\n> > b",
    "> > - a\n> > > b",
    "- > - a\n  > > b",
    "> - a\n> - b\n> > c",
    "> 1.\n> 2)",
    "> 2)\n>\n>",
    "> - 1. [\n>\n>   a",
    // The second list's bullet must not join a rule on its first line.
    "-\n* ---",
    // A shortcut reference before a link that is written with brackets.
    "[r]: /u\n\n[r]<https://m>",
    "[r]: /u\n\n[r]<a@b.co>",
    "[r]: /u\n[s]: /v\n\n[r][][s]",
    // Vertical tabs are never trimmed, and their references decode to U+FFFD.
    "x\n\u000b",
    "\u000b\n(",
    "| a |\n| - |\n| \u000b |",
    // Decoded leading whitespace in code-fence metadata.
    "```js &#x20;\nx\n```",
    "```title &#x20; x\nx\n```",
    "```js &#x9;a\nx\n```",
    // A list that cannot interrupt a paragraph opens a quote after one.
    "- [\n  >\n  >2)",
    "- [\n  >\n  >-",
    "- [\n  >\n  > >2) x",
  ])("formats %j idempotently without changing its meaning", (source) => {
    roundtrip(source);
    const compiled = compileTopikContent(source);
    const formatted = formatTopikContent(source);
    if (!compiled.ok || !formatted.ok) throw new Error("Expected valid content");
    expect(compileTopikContent(formatted.formatted)).toMatchObject({ tree: compiled.tree });
  });

  test("blank lines after the last item of a quoted list leave it tight", () => {
    type Tree = { name?: string; children?: Tree[] };
    const firstList = (source: string): Tree | undefined => {
      const compiled = compileTopikContent(source);
      if (!compiled.ok) throw new Error("Expected valid content");
      const pending = [JSON.parse(JSON.stringify(compiled.tree)) as Tree];
      for (let node = pending.shift(); node; node = pending.shift()) {
        if (node.name === "ul") return node;
        pending.push(...(node.children ?? []).filter((child) => typeof child === "object"));
      }
    };
    for (const [quoted, plain] of [
      ["> - a\n>\n> > b", "- a"],
      ["> - a\n>\n>", "- a"],
      ["> - a\n> - b\n>\n> > c", "- a\n- b"],
      ["> 1. a\n>\n> - b", "- b"],
      // Blank lines between items or between an item's blocks still make it loose.
      ["> - a\n>\n> - b", "- a\n\n- b"],
      ["> - 1. a\n>\n>   b", "- 1. a\n\n  b"],
    ])
      expect(firstList(quoted)).toEqual(firstList(plain));
  });
});

describe("whitespace next to inline siblings", () => {
  function formatted(source: string): string {
    const result = formatTopikContent(source);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    return result.formatted;
  }

  test.each([
    ["a line ending before inline code", "line one ends\n`code` starts\n"],
    ["a space before inline code in a table cell", "| A     |\n| ----- |\n| x `y` |\n"],
    ["spaces around inline code in a strikethrough", "~~a `b` c~~\n"],
    ["a line ending after inline code", "`code` ends\nthe line\n"],
    ["a line ending between marks", "*a*\n**b**\n"],
    ["a lone space between inline code in a table cell", "| A       |\n| ------- |\n| `x` `y` |\n"],
  ])("writes %s literally", (_name, source) => {
    expect(formatted(source)).toBe(source);
    roundtrip(source);
  });

  test("whitespace at the edge of a cell or strikethrough still needs a reference", () => {
    // Markdown trims these, so only a character reference keeps them.
    for (const source of [
      "| A |\n| - |\n| &#x20;x |\n",
      "~~&#x20;a~~\n",
      // A text of only whitespace after inline code ends the cell.
      "| A |\n| - |\n| `x`&#x20; |\n",
      "| A |\n| - |\n| &#x20;`x` |\n",
    ]) {
      expect(formatted(source)).toContain("&#x20;");
      roundtrip(source);
    }
  });
});

test("whitespace after a hard break keeps its reference spelling", () => {
  for (const source of ["`c`\\\n&#xa;`d`\n", "`c`\\\n&#x20;`d`\n"]) {
    expect(formatTopikContent(source)).toMatchObject({ ok: true, formatted: source });
  }
});

test("a heading that starts with a footnote reference keeps its colon text", () => {
  // A line ending forces the setext form, whose first line starts with the reference.
  for (const [source, expected] of [
    ["# [^1]\\: x z&#xa;w\n\n[^1]: note\n", "[^1]\\: x z\nw\n=\n\n[^1]: note\n"],
    ["# [^1]\\: x\n\n[^1]: note\n", "# [^1]\\: x\n\n[^1]: note\n"],
  ]) {
    expect(formatTopikContent(source)).toMatchObject({ ok: true, formatted: expected });
    expect(formatTopikContent(expected)).toMatchObject({ ok: true, formatted: expected });
  }
});

test("a line ending before a footnote reference stays literal", () => {
  // `[^1]: b` at a line start would read as a footnote definition, so the colon is escaped
  // instead; without a colon the line needs nothing.
  for (const [source, expected] of [
    ["a&#xa;[^1]: b\n\n[^1]: note\n", "a\n[^1]\\: b\n\n[^1]: note\n"],
    ["`a`&#xa;[^1]: b\n\n[^1]: note\n", "`a`\n[^1]\\: b\n\n[^1]: note\n"],
    ["a\n[^1] and more.\n\n[^1]: note\n", "a\n[^1] and more.\n\n[^1]: note\n"],
  ]) {
    expect(formatTopikContent(source)).toMatchObject({ ok: true, formatted: expected });
    expect(formatTopikContent(expected)).toMatchObject({ ok: true, formatted: expected });
  }
});

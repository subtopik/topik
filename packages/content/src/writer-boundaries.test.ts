import { describe, expect, test } from "vite-plus/test";
import { parseDocument } from "./markdown.js";
import { sameDocumentMeaning } from "./document-meaning.js";
import { formatTopikContent } from "./format.js";
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

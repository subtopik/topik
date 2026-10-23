import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  formatDocument,
  formatTopikContent,
  parseDocument,
  rewriteTopikAssetOccurrences,
  sameDocumentMeaning,
  writeDocument,
} from "./index.js";
import { parse } from "./test-helpers.js";
import * as writer from "./writer.js";

afterEach(() => vi.restoreAllMocks());

test.each([
  ["**Hello**", "__Hello__\n"],
  ["1. One\n2. Two", "1) One\n2) Two"],
  ["[Read][ID]\n\n[id]: /guide", "[Read][id]\n\n[ID]: /guide"],
  ["[Read][Read]\n\n[Read]: /guide", "[Read][]\n\n[Read]: /guide"],
])("ignores cosmetic normalization of %s", (before, after) => {
  expect(sameDocumentMeaning(parse(before), parse(after))).toBe(true);
});

test.each([
  ["Text", "Text&#32;"],
  ["*Text*", "**Text**"],
  ["[Read](/guide)", "[Read](/other)"],
  ["[Read](/guide)", '[Read](/guide "")'],
  ['![Image](image.png "Title")', '![Other](image.png "Title")'],
  ["## Heading {% #one %}", "## Heading {% #two %}"],
  ["- One\n- Two", "- One\n\n- Two"],
  ["{% callout %}\nText\n{% /callout %}", '{% callout title="" %}\nText\n{% /callout %}'],
  ["{% if 0 %}\nA\n{% /if %}", "{% if -0 %}\nA\n{% /if %}"],
])("detects changed authored meaning in %s", (before, after) => {
  expect(sameDocumentMeaning(parse(before), parse(after))).toBe(false);
});

test("rejects a valid but lossy serializer result without returning partial output", () => {
  const source = "  ![Image](old.png)\r\n";
  vi.spyOn(writer, "serializeDocument").mockReturnValue("Image disappeared.\n");
  for (const result of [
    formatTopikContent(source),
    rewriteTopikAssetOccurrences(source, () => "new.png"),
  ]) {
    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [expect.objectContaining({ id: "topik-write-failed" })],
    });
    expect(result).not.toHaveProperty("formatted");
    expect(result).not.toHaveProperty("content");
  }
});

test("checks unselected branches without evaluating their conditions", () => {
  const source = "{% if $missing %}\nKeep\n{% else /%}\nAlso keep\n{% /if %}";
  vi.spyOn(writer, "serializeDocument").mockReturnValue(source.replace("Also keep", "Changed"));
  expect(formatTopikContent(source)).toMatchObject({ ok: false, source });
});

test("writing, formatting, and rewriting preserve adjacent nested marks", () => {
  const source = "***_a_****_a_***";
  const document = parse(source);
  expect(document.children).toMatchObject([
    {
      type: "paragraph",
      children: [
        {
          type: "emphasis",
          children: ["a", "a"].map((value) => ({
            type: "strong",
            children: [{ type: "emphasis", children: [{ type: "text", value }] }],
          })),
        },
      ],
    },
  ]);
  const written = writeDocument(document);
  expect(sameDocumentMeaning(document, parse(written))).toBe(true);
  expect(writeDocument(parse(written))).toBe(written);
  for (const result of [formatTopikContent(source), formatDocument(source)]) {
    expect(result).toMatchObject({ ok: true, source, formatted: written });
  }
  expect(rewriteTopikAssetOccurrences(source, () => undefined)).toMatchObject({
    ok: true,
    content: written,
    diagnostics: [],
  });
});

test("merges adjacent text nodes while retaining an explicit empty title", () => {
  const document = parse('[Read](/guide "")');
  const paragraph = document.children[0];
  if (paragraph.type !== "paragraph" || paragraph.children[0].type !== "link")
    throw new Error("Expected link");
  const link = paragraph.children[0];
  link.children = [
    { type: "text", value: "Re" },
    { type: "text", value: "ad" },
  ];
  const written = writeDocument(document);
  expect(parseDocument(written)).toMatchObject({
    ok: true,
    document: { children: [{ children: [{ title: "", children: [{ value: "Read" }] }] }] },
  });
});

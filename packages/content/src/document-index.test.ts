import { describe, expect, test } from "vite-plus/test";
import {
  evaluateDocument,
  extractTopikAssetOccurrences,
  formatTopikContent,
  parseDocument,
  parseTopikContent,
  rewriteAssets,
  transformTopikContent,
  validateTopikContent,
  writeDocument,
} from "./index.js";
import { parse, withoutPositions } from "./test-helpers.js";

describe("scoped reference bindings", () => {
  const source = [
    "[Outer][target]",
    "",
    "[target]: https://example.com/root",
    "",
    "{% if $teacher %}",
    "[Teacher][target]",
    "",
    "[target]: https://example.com/teacher",
    "{% if $advanced %}",
    "[Advanced][target]",
    "{% else /%}",
    "[Beginner][target]",
    "",
    "[target]: https://example.com/beginner",
    "{% /if %}",
    "{% else /%}",
    "[Student][target]",
    "",
    "[target]: https://example.com/student",
    "{% /if %}",
  ].join("\n");

  test("resolves nearest scope and retains every branch during source writing", () => {
    const formatted = formatTopikContent(source);
    expect(formatted.ok).toBe(true);
    if (!formatted.ok) throw new Error("Expected valid source");
    expect(
      extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true }).map(
        ({ parsedReference }) => parsedReference,
      ),
    ).toEqual([
      "https://example.com/root",
      "https://example.com/teacher",
      "https://example.com/teacher",
      "https://example.com/beginner",
      "https://example.com/student",
    ]);
    expect(withoutPositions(parse(formatted.formatted))).toEqual(withoutPositions(parse(source)));
    for (const variables of [
      { teacher: true, advanced: true },
      { teacher: true, advanced: false },
      { teacher: false },
    ])
      expect(transformTopikContent(parse(source), { variables })).toEqual(
        transformTopikContent(parse(formatted.formatted), { variables }),
      );
  });

  test("binds references before evaluation and produces a standalone writable document", () => {
    const authored = parse(source);
    const original = structuredClone(authored);
    for (const variables of [
      { teacher: true, advanced: true },
      { teacher: true, advanced: false },
      { teacher: false },
    ]) {
      const evaluated = evaluateDocument(authored, variables);
      expect(transformTopikContent(parse(writeDocument(evaluated)))).toEqual(
        transformTopikContent(authored, { variables }),
      );
    }
    expect(authored).toEqual(original);
  });

  test.each([
    ["https://example.com/file", []],
    ["javascript:alert(1)", ["link-scheme-unsafe"]],
    ["http://example.com/file", ["TOPIK_EXTERNAL_REFERENCE_UNSAFE"]],
    [
      "https://user:secret@example.com/file",
      ["link-url-credentials", "TOPIK_EXTERNAL_REFERENCE_UNSAFE"],
    ],
  ] as const)("validates reference targets in the inactive branch: %s", (url, expectedIds) => {
    const text = `{% if $show %}\n[Go][ref]\n\n[ref]: https://example.com\n{% else /%}\n[Go][ref]\n\n[ref]: ${url}\n{% /if %}`;
    const result = validateTopikContent(text, { config: { variables: { show: true } } });
    expect(result.valid).toBe(expectedIds.length === 0);
    expect(result.errors.map(({ id }) => id)).toEqual(expectedIds);
  });

  test("retains first-definition precedence within each scope", () => {
    const text = "[Go][ref]\n\n[ref]: https://example.com\n[ref]: javascript:alert(1)";
    expect(validateTopikContent(text).valid).toBe(true);
    expect(
      extractTopikAssetOccurrences(text, { includeGenericLinkCandidates: true }),
    ).toMatchObject([{ parsedReference: "https://example.com" }]);
  });

  test("hoists ordinary Markdown definitions through lists and blockquotes", () => {
    const text = "[Go][ref]\n\n> [ref]: https://example.com";
    expect(validateTopikContent(text).valid).toBe(true);
    expect(
      extractTopikAssetOccurrences(text, { includeGenericLinkCandidates: true }),
    ).toMatchObject([{ parsedReference: "https://example.com" }]);
  });

  test("rewrites only definitions used by images in their own scope", () => {
    const text =
      "[Navigation][id]\n\n[id]: guide.md\n\n{% if $show %}\n![Image][id]\n\n[id]: image.png\n{% /if %}";
    const document = parse(text);
    const calls: string[] = [];
    const rewritten = rewriteAssets(document, (url) => {
      calls.push(url);
      return "new.png";
    });
    expect(calls).toEqual(["image.png"]);
    expect(writeDocument(rewritten)).toContain("[id]: guide.md");
    expect(writeDocument(rewritten)).toContain("[id]: new.png");
  });

  test("refuses cross-branch references during admission instead of changing targets", () => {
    const text = "{% if $show %}\n[id]: https://example.com\n{% else /%}\n[Go][id]\n{% /if %}";
    expect(parseDocument(text)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ id: "topik-reference-missing" })],
    });
  });
});

test.each([
  "[Go][&CounterClockwiseContourIntegral;]\n\n[&CounterClockwiseContourIntegral;]: https://example.com",
  "[Go][a\\[b\\]]\n\n[a\\[b\\]]: https://example.com",
  "[First][a] [Second][\u00a0a]\n\n[a]: https://example.com/first\n[\u00a0a]: https://example.com/second",
  "[Go][A B]\n\n[a  b]: https://example.com",
  "[Go][Straße]\n\n[STRASSE]: https://example.com",
  "[Go][a\\*]\n\n[a\\*]: https://example.com",
  "[Go][a&amp;b]\n\n[a&amp;b]: https://example.com",
  "[A][]\n\n[a]: https://example.com",
  "[A]\n\n[a]: https://example.com",
  "[First][a&amp;b] [Second][a&b]\n\n[a&amp;b]: https://example.com/first\n[a&b]: https://example.com/second",
  "[First][a\\*] [Second][a*]\n\n[a\\*]: https://example.com/first\n[a*]: https://example.com/second",
  "| Reference |\n| --- |\n| [Go][a\\|b] |\n\n[a|b]: https://example.com",
])("retains reference meaning through normalization: %s", (source) => {
  const document = parseTopikContent(source);
  const written = writeDocument(document);
  expect(transformTopikContent(parseTopikContent(written))).toEqual(
    transformTopikContent(document),
  );
  expect(writeDocument(parseTopikContent(written))).toBe(written);
});

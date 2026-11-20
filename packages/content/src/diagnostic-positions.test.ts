import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  compileTopikContent,
  formatTopikContent,
  rewriteTopikAssetOccurrences,
  rewriteTopikNavigationReferences,
  toTopikContentDiagnostic,
  validateTopikContent,
} from "./index.js";
import { locateMeaningDifference } from "./document-meaning.js";
import { parse } from "./test-helpers.js";
import * as writer from "./writer.js";

afterEach(() => vi.restoreAllMocks());

describe("diagnostic columns", () => {
  test.each([
    ["  [x](javascript:alert(1))", "link-scheme-unsafe", 1, 3],
    [
      'Text\n\n  {% card title="A" href="javascript:x" %}\nx\n{% /card %}',
      "link-scheme-unsafe",
      3,
      3,
    ],
    ["Intro\n\n  [x](http://example.test)", "TOPIK_EXTERNAL_REFERENCE_UNSAFE", 3, 3],
    ['  {% figure src="http://x.test/a.png" alt="a" /%}', "TOPIK_EXTERNAL_REFERENCE_UNSAFE", 1, 3],
    ["## A {% #a %}\n\n  ## B {% #a %}", "heading-id-duplicate", 3, 3],
    ["text <b>html</b>", "node-undefined", 1, 6],
    ["{% tabs %}\nhello\n{% /tabs %}", "topik-tabs-children", 1, 1],
  ])("validation of %j reports line and column", (source, id, line, column) => {
    expect(validateTopikContent(source, { file: "guide.md" }).errors).toContainEqual(
      expect.objectContaining({ id, lines: [line], column, file: "guide.md" }),
    );
  });

  test("custom component asset diagnostics carry a column", () => {
    const config = {
      components: {
        poster: {
          kind: "block" as const,
          render: "Poster",
          attributes: { src: { type: "string" as const, asset: true } },
          children: "none" as const,
        },
      },
    };
    expect(
      validateTopikContent('Text\n\n  {% poster src="http://x.test/a.png" /%}', { config }).errors,
    ).toContainEqual(
      expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", lines: [3], column: 3 }),
    );
  });

  test("compile-time variable diagnostics carry a column", () => {
    expect(compileTopikContent("Hello {% $missing %}")).toMatchObject({
      ok: false,
      diagnostics: [{ id: "topik-variable-missing", lines: [1], column: 7 }],
    });
  });

  test("every positioned validation diagnostic has both a line and a column", () => {
    const sources = [
      "{% callout kind=1 %}\nx\n{% /callout %}",
      "{% nope /%}",
      "{% /callout %}",
      "{% callout %}\nx",
      "x[^1]\n\n[^2]: n",
      "```js lines=0\nx\n```",
      "{% badge %}{% /badge %}",
      "[a][b]\n\n[b]: http://x.test",
      "[x](https://user:secret@example.test)",
    ];
    for (const source of sources) {
      const { errors } = validateTopikContent(source);
      expect(errors.length).toBeGreaterThan(0);
      for (const error of errors)
        expect({ source, id: error.id, column: typeof error.column }).toEqual({
          source,
          id: error.id,
          column: error.lines.length ? "number" : "undefined",
        });
    }
  });

  test("toTopikContentDiagnostic keeps a valid column", () => {
    const issue = {
      type: "link",
      lines: [2],
      error: { id: "link-href-empty", level: "error" as const, message: "untrusted" },
    };
    expect(toTopikContentDiagnostic({ ...issue, column: 4 })).toMatchObject({
      lines: [2],
      column: 4,
    });
    expect(toTopikContentDiagnostic({ ...issue, column: -1 })).not.toHaveProperty("column");
  });
});

describe("write failure location", () => {
  test("formatting reports the authored node whose meaning would change", () => {
    const source = "# Title\n\nFirst paragraph.\n\n> Quoted *text*.\n";
    vi.spyOn(writer, "serializeDocument").mockReturnValue(
      "# Title\n\nFirst paragraph.\n\n> Quoted *other*.\n",
    );
    expect(formatTopikContent(source, { file: "guide.md" })).toEqual({
      ok: false,
      source,
      diagnostics: [
        {
          id: "topik-write-failed",
          type: "document",
          level: "error",
          message: "Content could not be written without changing its meaning.",
          lines: [5],
          column: 11,
          file: "guide.md",
        },
      ],
    });
  });

  test("asset and navigation rewrites report the changed node", () => {
    const source = "Intro\n\n- item ![Image](old.png)\n";
    vi.spyOn(writer, "serializeDocument").mockReturnValue("Intro\n\n- item\n");
    expect(rewriteTopikAssetOccurrences(source, () => "new.png")).toMatchObject({
      ok: false,
      diagnostics: [{ id: "topik-write-failed", lines: [3], column: 3 }],
    });
    const links = "Intro\n\n  [Guide](guide.md)\n";
    vi.spyOn(writer, "serializeDocument").mockReturnValue("Intro\n\n[Other](/guide)\n");
    expect(rewriteTopikNavigationReferences(links, () => "/guide")).toMatchObject({
      ok: false,
      diagnostics: [{ id: "topik-write-failed", lines: [3], column: 4 }],
    });
  });

  test("locates the deepest positioned difference, or none for equal documents", () => {
    const authored = parse("# Title\n\n- one\n- two **bold**\n");
    expect(locateMeaningDifference(authored, parse("# Title\n\n- one\n- two **bold**\n"))).toBe(
      undefined,
    );
    expect(locateMeaningDifference(authored, parse("# Title\n\n- one\n- two bold\n"))).toEqual({
      line: 4,
      column: 3,
    });
    // An authored block missing from the output is located at that block.
    expect(locateMeaningDifference(authored, parse("# Title\n"))).toEqual({ line: 3, column: 1 });
    // Output-only content has no authored node; the root is not a location.
    expect(locateMeaningDifference(parse("# Title\n"), authored)).toBe(undefined);
  });
});

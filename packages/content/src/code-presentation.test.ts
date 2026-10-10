import { describe, expect, test } from "vitest";
import { decodeString } from "micromark-util-decode-string";
import {
  CODE_PRESENTATION_LIMITS,
  CodePresentationError,
  codePresentationChildRows,
  codePresentationMetadataLength,
  codePresentationProblem,
  codePresentationRows,
  effectiveCodePresentationOptions,
  encodeCodePresentationSuffix,
  normalizeCodePresentationOptions,
  parseCodeLineSelection,
  parseCodePresentationMetadata,
  serializeCodePresentationMetadata,
} from "./code-presentation.js";
import type { TreeNode } from "./model.js";

function metadata(source: string, rows = 4) {
  const result = parseCodePresentationMetadata(source, rows);
  if (!result) throw new Error("Expected recognized presentation attributes");
  return result;
}

describe("compact code presentation options", () => {
  test("unknown-only metadata remains ordinary while explicit defaults remain authored", () => {
    for (const source of [
      "",
      "legacy-note",
      "unknown=true lines",
      "custom-code:1 {}",
      "lineNumbers=true",
      "lines:note",
      "wrap:note",
      "filename:note",
      "lines\\=false",
      "lines?",
      "wrap/",
    ])
      expect(parseCodePresentationMetadata(source, 4)).toBeUndefined();
    expect(metadata("lines=false startLine=1 wrap=false").options).toEqual({
      lineNumbers: false,
      startLine: 1,
      wrap: false,
    });
    const omitted = normalizeCodePresentationOptions({}, 4);
    expect(effectiveCodePresentationOptions(omitted)).toEqual({
      lineNumbers: false,
      startLine: 1,
      wrap: false,
    });
    expect(omitted).toEqual({});
  });

  test("accepts flags and single/double quoted or bare values with normalization", () => {
    expect(
      metadata(
        'filename="client.ts" title=\'Create a client\' lines startLine = 10 highlight="4,1,3,3-4" focus=3-4 collapseAfter=2 wrap=false added=3 removed="4"',
      ).options,
    ).toEqual({
      filename: "client.ts",
      title: "Create a client",
      lineNumbers: true,
      startLine: 10,
      highlight: [
        [1, 1],
        [3, 4],
      ],
      focus: [[3, 4]],
      collapseAfter: 2,
      wrap: false,
      added: [[3, 3]],
      removed: [[4, 4]],
    });
    expect(metadata("lines=\"true\" wrap='false'").options).toEqual({
      lineNumbers: true,
      wrap: false,
    });
    expect(metadata("lines wrap").options).toEqual({ lineNumbers: true, wrap: true });
  });

  test("normalizes caller interval arrays without mutating them or changing coordinates", () => {
    const input = {
      highlight: [
        [4, 4],
        [1, 1],
        [3, 3],
      ],
      startLine: 100,
    };
    const before = structuredClone(input);
    expect(normalizeCodePresentationOptions(input, 4)).toEqual({
      highlight: [
        [1, 1],
        [3, 4],
      ],
      startLine: 100,
    });
    expect(input).toEqual(before);
    expect(parseCodeLineSelection("4,1,3,3-4", 4)).toEqual([
      [1, 1],
      [3, 4],
    ]);
  });

  test.each([
    "",
    "0",
    "01",
    "-1",
    "+1",
    "1.5",
    "1-",
    "-2",
    "2-1",
    "1, 2",
    "1 -2",
    "1,,2",
    "5",
    "9007199254740992",
    "1-9999999999999999999999999",
  ])("refuses invalid or out-of-bounds selection %j", (value) =>
    expect(() => parseCodeLineSelection(value, 4)).toThrow(),
  );

  test("bounds intervals without expanding malicious endpoints into per-row lists", () => {
    expect(() => parseCodeLineSelection("1-1000000000", 4)).toThrow();
    expect(() =>
      parseCodeLineSelection(Array.from({ length: 1025 }, () => "1").join(","), 4),
    ).toThrow();
    expect(parseCodeLineSelection(Array.from({ length: 1024 }, () => "1").join(","), 4)).toEqual([
      [1, 1],
    ]);
  });

  test.each([
    "filename",
    "filename=",
    'filename=" "',
    'title=""',
    'title="two&#10;lines"',
    'title="\u007f"',
    'title="' + "x".repeat(257) + '"',
    "lines=1",
    "wrap=no",
    "startLine=0",
    "startLine=01",
    "startLine=1000000001",
    "startLine=1.1",
    "startLine=1e2",
    "collapseAfter=0",
    "collapseAfter=4",
    "added=1-2 removed=2-3",
    "highlight=",
    'highlight=""',
    "lines lines=false",
    "wrap=false wrap",
    "title=\"a\" title='b'",
    'title="unterminated',
    'title="x"wrap',
    "lines highlight",
    "lines highlight=garbage",
  ])("refuses malformed recognized attributes %j", (source) =>
    expect(() => metadata(source)).toThrow(),
  );

  test("retains every option after an unsupported word as an opaque suffix", () => {
    expect(metadata('lines \tlegacy-note highlight=garbage filename="opaque"')).toEqual({
      options: { lineNumbers: true },
      opaqueMetaSuffix: ' \tlegacy-note highlight=garbage filename="opaque"',
    });
    expect(metadata("wrap\t  ")).toEqual({ options: { wrap: true }, opaqueMetaSuffix: "\t  " });
    expect(() => metadata("wrap legacy&#10;value")).toThrow();
    for (const suffix of [" lines:note", " wrap:note", " filename:note", " lines\\=false"]) {
      const result = metadata("lines" + suffix);
      expect(result.options).toEqual({ lineNumbers: true });
      expect(result.opaqueMetaSuffix).toBe(decodeString(suffix));
    }
  });

  test("diff selections may intersect highlights/focus but cannot intersect one another", () => {
    expect(metadata("added=1-2 removed=3-4 highlight=1-4 focus=2").options).toEqual({
      added: [[1, 2]],
      removed: [[3, 4]],
      highlight: [[1, 4]],
      focus: [[2, 2]],
    });
    expect(() => metadata("collapseAfter=1", 1)).toThrow();
    expect(metadata("startLine=1000000000", 4).options.startLine).toBe(1_000_000_000);
  });

  test("diagnostics name only known options without exposing unknown metadata", () => {
    for (const [source, option] of [
      ["wrap=no", "wrap"],
      ["focus=0", "focus"],
      ["removed=5", "removed"],
      ['title=""', "title"],
      ["lines=no", "lineNumbers"],
    ]) {
      try {
        metadata(source);
        throw new Error("Expected invalid authored options");
      } catch (error) {
        expect(error).toBeInstanceOf(CodePresentationError);
        expect((error as CodePresentationError).option).toBe(option);
      }
    }
    expect(new CodePresentationError("code", "message", "private-key").option).toBeUndefined();
  });
});

describe("compact raw metadata and canonical headers", () => {
  test("parses quote structure before exactly one CommonMark value decoding pass", () => {
    const result = metadata(
      'filename="C:\\source.ts" title="A &amp; \\"quoted\\" `" lines  legacy&#x26;amp;value &#92;* &#96;',
    );
    expect(result).toEqual({
      options: { filename: "C:\\source.ts", title: 'A & "quoted" `', lineNumbers: true },
      opaqueMetaSuffix: "  legacy&amp;value \\* `",
    });
    const written = serializeCodePresentationMetadata(result.options, result.opaqueMetaSuffix);
    expect(written).toBe(
      'filename="C:&#92;source.ts" title="A & \\"quoted\\" &#96;" lines  legacy&#38;amp;value &#92;* &#96;',
    );
    expect(metadata(written)).toEqual(result);
    expect(metadata('title="\\n is literal text"').options.title).toBe("\\n is literal text");
    expect(metadata("title='It\\'s simple'").options.title).toBe("It's simple");
  });

  test("canonical output uses readable attributes and preserves explicit false", () => {
    const options = {
      wrap: true,
      highlight: [
        [4, 4],
        [3, 3],
        [1, 1],
      ] as Array<[number, number]>,
      filename: "a.ts",
      lineNumbers: false,
    };
    expect(serializeCodePresentationMetadata(options, "  legacy ")).toBe(
      'filename="a.ts" lines=false highlight="1,3-4" wrap  legacy ',
    );
    expect(serializeCodePresentationMetadata({ lineNumbers: true, wrap: false }, "")).toBe(
      "lines wrap=false",
    );
  });

  test("attribute entities, literal backslashes and fence backticks round-trip", () => {
    for (const title of [
      'a"\\&`',
      "a😀b",
      "a\ud800b",
      "a\udc00b",
      "&amp; &#38; &#x26;",
      "A & B",
      "{ \\\\ }",
    ]) {
      const options = {
        title,
        highlight: [
          [1, 1],
          [3, 4],
        ] as Array<[number, number]>,
      };
      const suffix = "\t &\\` &#38;";
      const written = serializeCodePresentationMetadata(options, suffix);
      expect(codePresentationMetadataLength(options, suffix)).toBe(written.length);
      expect(metadata(written)).toEqual({ options, opaqueMetaSuffix: suffix });
    }
    expect(serializeCodePresentationMetadata({ title: "A & B" }, "")).toBe('title="A & B"');
    expect(serializeCodePresentationMetadata({ title: "&amp;" }, "")).toBe('title="&#38;amp;"');
  });

  test("suffix encoding preserves entity-looking text and does not activate decoded option names", () => {
    for (const suffix of [
      " legacy&amp;value",
      " &#x26; &#38; &amp;",
      " \\\\ \\& \\`",
      "\t  &`\\  ",
      " ",
      "\t\t",
      " lines",
      ' title="opaque"',
      " filename=opaque",
      " collapseAfter=100",
      " lines:note",
      " wrap:note",
      " filename:note",
      " lines\\=false",
    ]) {
      expect(decodeString(encodeCodePresentationSuffix(suffix))).toBe(suffix);
      const options = { wrap: true };
      const written = serializeCodePresentationMetadata(options, suffix);
      expect(codePresentationMetadataLength(options, suffix)).toBe(written.length);
      expect(metadata(written, 1)).toEqual({ options, opaqueMetaSuffix: suffix });
    }
    expect(metadata("wrap &#108;ines")).toEqual({
      options: { wrap: true },
      opaqueMetaSuffix: " lines",
    });
    expect(encodeCodePresentationSuffix(" lines:note")).toBe(" lines:note");
    expect(encodeCodePresentationSuffix(" wrap:note")).toBe(" wrap:note");
    expect(encodeCodePresentationSuffix(" filename:note")).toBe(" filename:note");
    expect(encodeCodePresentationSuffix(" lines\\=false")).toBe(" lines&#92;=false");
  });

  test("bounds active attributes independently of an opaque suffix", () => {
    const source = "lines" + " ".repeat(CODE_PRESENTATION_LIMITS.metadataLength) + "wrap";
    expect(() => metadata(source)).toThrow();
    const suffix = " " + "&".repeat(4000);
    const written = serializeCodePresentationMetadata({ wrap: true }, suffix);
    expect(written.length).toBeGreaterThan(CODE_PRESENTATION_LIMITS.metadataLength);
    expect(metadata(written, 1).opaqueMetaSuffix).toBe(suffix);
  });

  test("canonical attributes retain the same metadata budget for caller-built ASTs", () => {
    const make = (offset: number) =>
      Array.from({ length: 1024 }, (_, index) => [index * 2 + offset, index * 2 + offset]);
    const options = { highlight: make(1), focus: make(1), added: make(1), removed: make(2) };
    expect(() => serializeCodePresentationMetadata(options as never, "")).toThrow();
  });

  test("empty internal presentation options cannot produce an authored fence", () => {
    expect(() => serializeCodePresentationMetadata({}, "")).toThrow();
    expect(() => codePresentationMetadataLength({}, "")).toThrow();
  });
});

describe("compact presentation authoring node admission", () => {
  const node = (
    options: unknown = { wrap: false },
    child: TreeNode = { type: "code", value: "a\nb\nc\n" },
  ): TreeNode =>
    ({
      type: "topikCodePresentation",
      options,
      opaqueMetaSuffix: "",
      children: [child],
    }) as TreeNode;

  test("counts physical rows without counting the copy separator", () => {
    expect(codePresentationRows("")).toBe(1);
    expect(codePresentationRows("a")).toBe(1);
    expect(codePresentationRows("a\n")).toBe(2);
    expect(
      codePresentationChildRows({
        type: "topikCodeTemplate",
        template: {
          type: "topikTextTemplate",
          segments: [
            { type: "literal", value: "a\n" },
            { type: "variable", path: ["name"] },
            { type: "literal", value: "\nb\n" },
          ],
        },
      }),
    ).toBe(4);
    expect(codePresentationProblem(node({ highlight: [[4, 4]] }))).toBeUndefined();
    expect(codePresentationProblem(node({ highlight: [[5, 5]] }))).toMatchObject({
      id: "topik-code-presentation-line-bounds",
      option: "highlight",
    });
  });

  test("requires one payload child and at least one authoritative option", () => {
    for (const input of [
      node({}),
      { ...node(), children: [] },
      {
        ...node(),
        children: [
          { type: "code", value: "a" },
          { type: "code", value: "b" },
        ],
      },
      { ...node(), children: [{ type: "paragraph", children: [] }] },
      node(undefined, { type: "code", value: "x", lang: "text", meta: "legacy" }),
      node(undefined, { type: "code", value: "x", lang: "mermaid" }),
      node(undefined, { type: "code", value: "x", lang: "" }),
      node(undefined, { type: "code", value: "x", lang: "two words" }),
      node(undefined, { type: "code", value: "x", lang: "two\twords" }),
      node(undefined, { type: "code", value: "x", lang: "two\nwords" }),
      { ...node(), extra: true },
      { ...node(), opaqueMetaSuffix: "missing separator" },
    ])
      expect(codePresentationProblem(input as TreeNode)).toBeDefined();
  });

  test("bounds physical rows and canonical options before rendering", () => {
    expect(
      codePresentationProblem(node(undefined, { type: "code", value: "\n".repeat(19999) })),
    ).toBeUndefined();
    expect(
      codePresentationProblem(node(undefined, { type: "code", value: "\n".repeat(20000) })),
    ).toMatchObject({ id: "topik-content-limit" });
    const make = (offset: number) =>
      Array.from({ length: 1024 }, (_, index) => [index * 2 + offset, index * 2 + offset]);
    expect(
      codePresentationProblem(
        node(
          { highlight: make(1), focus: make(1), added: make(1), removed: make(2) },
          { type: "code", value: "\n".repeat(3000) },
        ),
      ),
    ).toMatchObject({ id: "topik-content-limit" });
  });

  test("malformed caller templates return diagnostics without row-count exceptions", () => {
    for (const template of [
      { type: "topikTextTemplate", segments: {} },
      { type: "topikTextTemplate", segments: [null] },
      { type: "topikTextTemplate", segments: [{ type: "literal", value: 123 }] },
    ]) {
      const child = { type: "topikCodeTemplate", template } as unknown as TreeNode;
      expect(() => codePresentationChildRows(child)).not.toThrow();
      expect(() => codePresentationProblem(node(undefined, child))).not.toThrow();
      expect(codePresentationProblem(node(undefined, child))).toBeDefined();
    }
  });

  test("own-data checks never invoke option or interval getters", () => {
    let calls = 0;
    const options = {
      get wrap() {
        calls++;
        return true;
      },
    };
    expect(() => normalizeCodePresentationOptions(options, 2)).toThrow();
    expect(calls).toBe(0);
    expect(() => normalizeCodePresentationOptions(Object.create({ wrap: true }), 2)).toThrow();
    const array = [[1, 1]];
    Object.defineProperty(array, "0", {
      get() {
        calls++;
        return [1, 1];
      },
      enumerable: true,
    });
    expect(() => normalizeCodePresentationOptions({ highlight: array }, 2)).toThrow();
    expect(calls).toBe(0);
  });

  test("shared arrays and tuples fail within options and across authoring positions", () => {
    const interval = [1, 1];
    expect(() =>
      normalizeCodePresentationOptions({ highlight: [interval, interval] }, 2),
    ).toThrow();
    expect(() =>
      normalizeCodePresentationOptions({ highlight: [interval], added: [interval] }, 2),
    ).toThrow();
    const options = { wrap: false };
    const seen = new Set<object>();
    expect(codePresentationProblem(node(options), seen)).toBeUndefined();
    expect(codePresentationProblem(node(options), seen)).toMatchObject({
      id: "topik-code-presentation-metadata",
    });
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => normalizeCodePresentationOptions({ highlight: cyclic }, 2)).toThrow();
  });
});

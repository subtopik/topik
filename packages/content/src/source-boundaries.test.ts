import { describe, expect, test, vi } from "vite-plus/test";
import {
  extractTopikAssetOccurrences,
  formatTopikContent,
  parseTopikContent,
  removeInvalidTopikAssetReferences,
  rewriteTopikAssetOccurrences,
  transformTopikContent,
  validateDocument,
  validateTopikContent,
  type ContentDocument,
  type TopikContentConfig,
} from "./index.js";

describe("source boundaries", () => {
  test.each([
    "mailto:hello@example.com",
    "tel:+123456",
    "#section",
    "/guide",
    "../guide.md",
    "https://example.com/guide",
  ])("asset sanitization preserves admitted navigation %s", (href) => {
    for (const source of [`[Contact](${href})`, `[Contact][id]\n\n[id]: ${href}`]) {
      expect(validateTopikContent(source).valid).toBe(true);
      for (const evidence of [source, undefined]) {
        const document = parseTopikContent(source);
        const before = transformTopikContent(document);
        removeInvalidTopikAssetReferences(document, evidence);
        expect(validateDocument(document)).toEqual([]);
        expect(transformTopikContent(document)).toEqual(before);
      }
    }
  });

  test.each([
    "javascript:alert(1)",
    "http://example.com/file",
    "https://user:secret@example.com/file",
    "asset:invalid",
    "//example.com/file",
  ])("unsafe links retain their label as renderable content: %s", (href) => {
    for (const source of [`[**Contact**](${href})`, `[**Contact**][id]\n\n[id]: ${href}`]) {
      const document = parseTopikContent(source);
      removeInvalidTopikAssetReferences(document, source);
      expect(validateDocument(document)).toEqual([]);
      expect(transformTopikContent(document)).toMatchObject({
        children: expect.arrayContaining([
          expect.objectContaining({
            name: "p",
            children: [expect.objectContaining({ name: "strong", children: ["Contact"] })],
          }),
        ]),
      });
    }
  });

  test.each([
    "javascript:alert(1)",
    "http://example.com/file.png",
    "asset:invalid",
    "/absolute.png",
  ])("refuses invalid replacement %s without exposing partial output", (replacement) => {
    const source = "  ![One](one.png) ![Two](two.png)\r\n";
    const result = rewriteTopikAssetOccurrences(source, ({ reference }) =>
      reference === "one.png" ? "new.png" : replacement,
    );
    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("content");
  });

  test("accepts generated assets only at the compiled output boundary", () => {
    const source = "![Image](image.png)";
    const result = rewriteTopikAssetOccurrences(source, () => `asset:auto-v1-${"a".repeat(52)}`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected compiled output");
    expect(validateTopikContent(result.content).valid).toBe(false);
    expect(validateTopikContent(result.content, { allowCompiledAssetReferences: true }).valid).toBe(
      true,
    );
  });

  test("keeps a schema snapshot when a replacement callback mutates caller configuration", () => {
    const config: TopikContentConfig = {
      components: { panel: { kind: "block", render: "Panel", attributes: {}, children: "blocks" } },
    };
    const result = rewriteTopikAssetOccurrences(
      "{% panel %}\n![Image](image.png)\n{% /panel %}",
      () => {
        delete config.components!.panel;
        return "new.png";
      },
      { config },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected rewritten output");
    expect(result.content).toContain("{% panel %}");
    expect(result.content).toContain("new.png");
  });

  test("propagates application callback failures", () => {
    const error = new Error("Application failure");
    expect(() =>
      rewriteTopikAssetOccurrences("![Image](image.png)", () => {
        throw error;
      }),
    ).toThrow(error);
  });

  test.each(["functions", "partials", "tags", "nodes"])(
    "refuses removed %s configuration before formatting or replacement",
    (field) => {
      const source = "  ![Image](old.png)\r\n";
      const callback = vi.fn(() => "new.png");
      const config = { [field]: { custom: callback } } as TopikContentConfig;
      const formatted = formatTopikContent(source, { config });
      const rewritten = rewriteTopikAssetOccurrences(source, callback, { config });
      expect(formatted).toMatchObject({ ok: false, source });
      expect(formatted).not.toHaveProperty("formatted");
      expect(rewritten).toMatchObject({ ok: false, source });
      expect(rewritten).not.toHaveProperty("content");
      expect(callback).not.toHaveBeenCalled();
    },
  );

  test("rewrites one shared-reference occurrence without retargeting siblings or navigation", () => {
    const source =
      '![First][shared] ![Second][shared] [Navigate][shared]\n\n[shared]: old.png "Shared title"';
    const result = rewriteTopikAssetOccurrences(source, (occurrence) =>
      occurrence.semantics.alt === "First" ? "new.png" : undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const occurrences = extractTopikAssetOccurrences(result.content, {
      includeGenericLinkCandidates: true,
    });
    expect(occurrences.map(({ reference, semantics }) => ({ reference, semantics }))).toEqual([
      {
        reference: "new.png",
        semantics: { alt: "First", decorative: false, title: "Shared title" },
      },
      {
        reference: "old.png",
        semantics: { alt: "Second", decorative: false, title: "Shared title" },
      },
      { reference: "old.png", semantics: { linkLabel: "Navigate", title: "Shared title" } },
    ]);
  });

  test("rewrites both authored branches and keeps the reader condition unresolved", () => {
    const source =
      '{% if $teacher %}\n![Teacher](teacher.png)\n{% else /%}\n{% figure src="student.png" alt="Student" /%}\n{% /if %}';
    const result = rewriteTopikAssetOccurrences(
      source,
      (occurrence) => `compiled-${occurrence.reference}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("{% if $teacher %}");
    expect(result.content).toContain("{% else /%}");
    expect(extractTopikAssetOccurrences(result.content).map(({ reference }) => reference)).toEqual([
      "compiled-teacher.png",
      "compiled-student.png",
    ]);
  });

  test("refuses unsafe references in an inactive branch before calling the replacer", () => {
    const source =
      "{% if $visible %}\n![Unsafe](http://example.com/image.png)\n{% else /%}\nSafe\n{% /if %}";
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, {
      config: { variables: { visible: false } },
    });
    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE" })],
    });
    expect(replace).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    "sanitizes an authoring tree with source evidence=%s",
    (includeSource) => {
      const source =
        '![Unsafe](http://example.com/image.png)\n\n{% figure src="https://example.com/safe.png" darkSrc="asset:invalid" alt="Theme" /%}';
      const document = parseTopikContent(source);
      removeInvalidTopikAssetReferences(document, includeSource ? source : undefined);
      expect(document.children).toMatchObject([
        { type: "paragraph", children: [{ type: "text", value: "Unsafe" }] },
        { type: "topikComponent", props: { src: "https://example.com/safe.png", alt: "Theme" } },
      ]);
      expect(document.children[1]).not.toHaveProperty("props.darkSrc");
      expect(validateDocument(document)).toEqual([]);
      expect(() => transformTopikContent(document)).not.toThrow();
    },
  );

  describe.each([
    ["structured clone", (document: ContentDocument) => structuredClone(document)],
    [
      "JSON copy",
      (document: ContentDocument) => JSON.parse(JSON.stringify(document)) as ContentDocument,
    ],
  ] as const)("preview sanitization of a %s", (_name, copy) => {
    test.each(["\n", "\r\n", "\r"])("preserves safe resources with line endings %j", (ending) => {
      const source = [
        "![Logo](images/logo.png) [Site](https://example.com)",
        "",
        "> ![Reference][image]",
        ">",
        "> [image]:",
        ">   images/reference.png",
        "",
        "{% if $show %}",
        "![First][scoped]",
        "",
        "[scoped]: images/first.png",
        "{% else /%}",
        "![Second][scoped]",
        "",
        "[scoped]: images/second.png",
        "{% /if %}",
        "",
        "![Unsafe](http://example.com/image.png) ![Escaped](images/logo\\.png)",
        "![Entity](images/l&#111;go.png)",
      ].join(ending);
      const authored = parseTopikContent(source);
      const original = structuredClone(authored);
      const preview = copy(authored);
      const expected = parseTopikContent(source);
      removeInvalidTopikAssetReferences(expected, source);
      removeInvalidTopikAssetReferences(preview, source);
      expect(preview).toEqual(expected);
      expect(authored).toEqual(original);
      for (const show of [true, false]) {
        const tree = transformTopikContent(preview, { variables: { show } });
        expect(tree).toMatchObject({
          children: [
            {
              children: [
                { name: "TopikImage", attributes: { src: "images/logo.png" } },
                " ",
                { name: "TopikLink", attributes: { href: "https://example.com" } },
              ],
            },
            {
              children: [
                { children: [{ name: "TopikImage", attributes: { src: "images/reference.png" } }] },
                null,
              ],
            },
            {
              children: [
                {
                  name: "TopikImage",
                  attributes: { src: show ? "images/first.png" : "images/second.png" },
                },
              ],
            },
            null,
            { children: ["Unsafe Escaped\nEntity"] },
          ],
        });
      }
    });

    test("recovers source evidence inside custom components", () => {
      const config: TopikContentConfig = {
        components: {
          notice: { kind: "block", render: "Notice", attributes: {}, children: "blocks" },
          label: {
            kind: "inline",
            render: "Label",
            attributes: { title: { type: "string" } },
            children: "inline",
          },
        },
      };
      const source =
        '{% notice %}\n![Logo](images/logo.png)\n\n[Read {% label title="[detail]" %}here{% /label %}](https://example.com)\n{% /notice %}';
      const authored = parseTopikContent(source, { config });
      const preview = copy(authored);
      removeInvalidTopikAssetReferences(preview, source, { config });
      expect(preview).toEqual(authored);
    });

    test("does not borrow source evidence for changed or positionless resources", () => {
      const source = "![Logo](images/logo.png)";
      for (const change of ["destination", "position"] as const) {
        const preview = copy(parseTopikContent(source));
        const paragraph = preview.children[0];
        if (paragraph.type !== "paragraph" || paragraph.children[0].type !== "image")
          throw new Error("Expected image");
        if (change === "destination") paragraph.children[0].url = "images/changed.png";
        else delete paragraph.children[0].position;
        removeInvalidTopikAssetReferences(preview, source);
        expect(preview.children).toMatchObject([{ children: [{ type: "text", value: "Logo" }] }]);
      }
    });
  });

  test("sanitizes nested resources and removes empty inline wrappers", () => {
    const source = [
      "[![Logo](http://example.com/logo.png)](javascript:alert(1))",
      "",
      "{% badge %}**![](http://example.com/empty.png)**{% /badge %}",
      "",
      "![Reference][bad]",
      "",
      "[bad]: http://example.com/reference.png",
    ].join("\n");
    const document = parseTopikContent(source);
    removeInvalidTopikAssetReferences(document, source);
    expect(validateDocument(document)).toEqual([]);
    expect(transformTopikContent(document)).toMatchObject({
      children: [{ name: "p", children: ["Logo"] }, { name: "p", children: ["Reference"] }, null],
    });
  });

  test("preserves figure descriptions when removing an unsafe required source", () => {
    const source =
      '{% figure src="http://example.com/image.png" alt="Diagram" caption="Overview" /%}';
    const document = parseTopikContent(source);
    removeInvalidTopikAssetReferences(document, source);
    expect(validateDocument(document)).toEqual([]);
    expect(transformTopikContent(document)).toMatchObject({
      children: [{ name: "p", children: ["Diagram\nOverview"] }],
    });
  });

  test("preserves navigation sharing a definition with a rejected image", () => {
    const source = "![Image][id] [Page][id]\n\n[id]: /guide";
    const document = parseTopikContent(source);
    removeInvalidTopikAssetReferences(document, source);
    expect(validateDocument(document)).toEqual([]);
    expect(transformTopikContent(document)).toMatchObject({
      children: [
        { name: "p", children: ["Image ", { name: "TopikLink", attributes: { href: "/guide" } }] },
        null,
      ],
    });
  });

  test("does not leave a trailing hard break after removing a decorative image", () => {
    const document = parseTopikContent("Before  \n![](http://example.com/empty.png)");
    removeInvalidTopikAssetReferences(document);
    expect(validateDocument(document)).toEqual([]);
    expect(transformTopikContent(document)).toMatchObject({
      children: [{ name: "p", children: ["Before"] }],
    });
  });
});

import { describe, expect, test, vi } from "vite-plus/test";
import { validateTopikContent } from "./validate.js";
import { formatTopikContent, rewriteTopikAssetOccurrences } from "./index.js";
describe("source asset validation", () => {
  test("preserves separate asset error locations across source operations", () => {
    const source =
      "# Heading\n\n![One](http://example.com/one.png)\n\n![Two](http://example.com/two.png)";
    const expected = [3, 5].map((line) =>
      expect.objectContaining({
        id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE",
        type: "image.src",
        lines: [line],
        file: "lesson.md",
      }),
    );
    const options = { file: "lesson.md" };
    expect(validateTopikContent(source, options)).toMatchObject({ valid: false, errors: expected });
    expect(formatTopikContent(source, options)).toMatchObject({
      ok: false,
      source,
      diagnostics: expected,
    });
    const replace = vi.fn(() => "safe.png");
    expect(rewriteTopikAssetOccurrences(source, replace, options)).toMatchObject({
      ok: false,
      source,
      diagnostics: expected,
    });
    expect(replace).not.toHaveBeenCalled();
  });

  test("locates nested reference occurrences, figure slots, and download links", () => {
    const source = [
      "> ![One][image]",
      "",
      "{% if false %}",
      "![Two][image]",
      "{% /if %}",
      "",
      "[image]: http://example.com/image.png",
      "",
      '{% figure src="bad%2fpath.png" darkSrc="http://example.com/dark.png" alt="Figure" /%}',
      "",
      "[Download](http://example.com/manual.pdf)",
    ].join("\r\n");
    expect(validateTopikContent(source).errors).toEqual([
      expect.objectContaining({
        id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE",
        type: "image.src",
        lines: [1],
      }),
      expect.objectContaining({
        id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE",
        type: "image.src",
        lines: [4],
      }),
      expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "figure.src", lines: [9] }),
      expect.objectContaining({
        id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE",
        type: "figure.darkSrc",
        lines: [9],
      }),
      expect.objectContaining({
        id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE",
        type: "link.href",
        lines: [11],
      }),
    ]);
  });

  test.each([
    "http://example.com/a.png",
    "https://user:secret@example.com/a.png",
    "file:///tmp/a.png",
    "data:image/png;base64,AA==",
    "blob:https://example.com/id",
    "javascript:alert(1)",
    "//example.com/a.png",
    "/absolute.png",
    "assets%2fhero.png",
    "é.png",
  ])("rejects unsafe or noncanonical asset reference %s", (reference) => {
    const result = validateTopikContent(`{% figure src="${reference}" alt="Unsafe reference" /%}`);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^TOPIK_(?:ASSET_PATH_INVALID|EXTERNAL_REFERENCE_UNSAFE)$/u),
          level: "error",
        }),
      ]),
    );
  });

  test("accepts canonical local and credential-free HTTPS asset references", () => {
    expect(
      validateTopikContent(
        '{% figure src="assets/caf%C3%A9.png" darkSrc="https://example.com/dark.png?q=1#x" alt="Hero" /%}',
      ),
    ).toMatchObject({ valid: true, errors: [] });
    expect(
      validateTopikContent(
        "![External image](https://example.com/image.png)\n\n[External file](https://example.com/file.pdf)\n",
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("accepts mixed-case credential-free HTTPS in every Asset-capable Markdown form", () => {
    expect(
      validateTopikContent(
        [
          "![Image](HtTpS://example.com/image.png)",
          "[Download](hTTps://example.com/manual.pdf)",
          "<HTTPS://example.com/autolink.pdf>",
          '{% figure src="HTtPs://example.com/light.png" darkSrc="htTPs://example.com/dark.png" alt="Theme" /%}',
        ].join("\n\n"),
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("accepts image and possible-download references with Markdown titles", () => {
    // The full title matrix is exercised through rewriting's input admission
    // and semantic preservation checks in asset-references.test.ts.
    expect(
      validateTopikContent(
        '![Hero](hero.png "title (detail)")\n\n[Manual](manual.bin "title (detail)")\n',
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test.each([
    "[HTTP file](http://example.com/file.pdf)",
    "[Mixed HTTP](hTtP://example.com/file.pdf)",
    "<HTtp://example.com/file.pdf>",
    "[Credentialed HTTPS file](https://user:secret@example.com/file.pdf)",
    "<http://example.com/file.pdf>",
    "<https://user:secret@example.com/file.pdf>",
    "<person@example.com> <http://example.com/file.pdf>",
  ])("rejects unsafe HTTP policy in a possible download link: %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", type: "link.href" }),
      ]),
    });
  });

  test.each([
    "![Mixed HTTP](HtTp://example.com/image.png)",
    "![Mixed credentialed HTTPS](hTtPs://user:secret@example.com/image.png)",
    '{% figure src="HTtp://example.com/image.png" alt="Unsafe" /%}',
    '{% figure src="https://example.com/light.png" darkSrc="hTtPs://user:secret@example.com/dark.png" alt="Unsafe" /%}',
  ])("rejects unsafe mixed-case external media reference: %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE" }),
      ]),
    });
  });

  test("accepts a credential-free HTTPS autolink", () => {
    expect(validateTopikContent("<https://example.com/file.pdf>")).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test.each([
    ["http://example.com/file.pdf", "before"],
    ["http://example.com/file.pdf", "after"],
    ["https://user:secret@example.com/file.pdf", "before"],
    ["https://user:secret@example.com/file.pdf", "after"],
  ])(
    "rejects effective unsafe destination %s when a reference link appears %s",
    (reference, placement) => {
      const unavailable = "[Unavailable][id]";
      const parsed = `[Download](${reference})`;
      const paragraph =
        placement === "before" ? `${unavailable} ${parsed}` : `${parsed} ${unavailable}`;
      expect(validateTopikContent(`${paragraph}\n\n> [id]: ${reference}`)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", type: "link.href" }),
        ]),
      });
    },
  );

  test.each(["before", "after"])(
    "accepts effective credential-free HTTPS destinations when a reference link appears %s",
    (placement) => {
      const reference = "https://example.com/file.pdf";
      const unavailable = "[Unavailable][id]";
      const parsed = `[Download](${reference})`;
      const paragraph =
        placement === "before" ? `${unavailable} ${parsed}` : `${parsed} ${unavailable}`;
      expect(validateTopikContent(`${paragraph}\n\n> [id]: ${reference}`)).toMatchObject({
        valid: true,
        errors: [],
      });
    },
  );

  test.each([
    ["http://example.com/hero.png", false, "TOPIK_EXTERNAL_REFERENCE_UNSAFE"],
    ["https://user:secret@example.com/hero.png", false, "TOPIK_EXTERNAL_REFERENCE_UNSAFE"],
    ["https://example.com/hero.png", true, undefined],
    ["hero.png", true, undefined],
  ])(
    "applies exact-source and external policy to a reference definition and inline image destination %s",
    (reference, valid, diagnosticId) => {
      const source = `![Unavailable][id] ![Hero](${reference})\n\n> [id]: ${reference}`;
      expect(validateTopikContent(source)).toMatchObject(
        valid
          ? { valid: true, errors: [] }
          : {
              valid: false,
              errors: expect.arrayContaining([
                expect.objectContaining({
                  id: diagnosticId,
                  type: "image.src",
                }),
              ]),
            },
      );
    },
  );

  test("rejects Asset references in authoring input and permits generated names for output consumers", () => {
    const generated = `auto-v1-${"a".repeat(52)}`;
    expect(
      validateTopikContent(`{% card title="Asset" href="asset:${generated}" /%}`),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "link-asset-navigation-unsupported" }),
      ]),
    });
    expect(validateTopikContent(`![Compiled](asset:${generated})\n`)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED" }),
      ]),
    });
    expect(
      validateTopikContent(`![Compiled](asset:${generated})\n`, {
        allowCompiledAssetReferences: true,
      }),
    ).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test("reports malformed reserved generated names with a typed diagnostic", () => {
    expect(validateTopikContent("![Hero](asset:auto-v1-short)\n")).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED", type: "image.src" }),
      ]),
    });
  });

  test.each([
    "asset:company-logo",
    "asset:auto-v1-short",
    "ASSET:company-logo",
    "asset%3Acompany-logo",
    "%61sset%3Acompany-logo",
    "asset%3Acompany%ZZ",
    "asset&#58;company-logo",
  ])("rejects reserved Asset link spelling %s with a typed diagnostic", (reference) => {
    expect(validateTopikContent(`[Download](${reference})\n`)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          id: "TOPIK_ASSET_REFERENCE_MALFORMED",
          type: "link.href",
        }),
      ]),
    });
  });

  test("rejects a raw non-ASCII reference-style image destination", () => {
    expect(validateTopikContent("![Hero][id]\n\n[id]: é.png\n")).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
    expect(
      validateTopikContent("![Good][good]\n\n[unused]: &eacute;.png\n[good]: good.png\n"),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("does not accept exact-source proof from an unrelated component attribute", () => {
    const source =
      '![x][id]\n\n{% callout title="![x](%C3%A9.png)" %}\nfoo\n{% /callout %}\n\n> [id]: é.png';
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test.each([
    "![Hero](&eacute;.png)\n",
    "![Hero][id]\n\n[id]: &eacute;.png\n",
    "![Hero](hero\\.png)\n",
    "![Hero][id]\n\n[id]: hero\\.png\n",
  ])("rejects parser-unescaped source destination bytes in %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test.each([
    "![Nested [raw]](é.png)\n",
    "![Nested [entity]](&eacute;.png)\n",
    "![Nested [escaped]](hero\\.png)\n",
    "![Nested [reference]][id]\n\n[id]: é.png\n",
    "![Nested [reference]][id]\n\n[id]: &eacute;.png\n",
    "![Nested [reference]][id]\n\n[id]: hero\\.png\n",
    "[![Nested image](é.png)](manual.bin)\n",
  ])("rejects exact noncanonical destinations behind nested labels in %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test("accepts canonical encoded destinations behind nested labels", () => {
    expect(
      validateTopikContent(
        "![Inline [canonical]](%C3%A9.png)\n\n![Reference [canonical]][id]\n\n[id]: %C3%A9.png\n",
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test.each([
    "![Inline `]`](é.png)\n",
    "![Inline `[`](&eacute;.png)\n",
    "![Inline `]`](hero\\.png)\n",
    "![Reference `]`][id]\n\n[id]: é.png\n",
    "![Reference `[`][id]\n\n[id]: &eacute;.png\n",
    "![Reference `]`][id]\n\n[id]: hero\\.png\n",
  ])("rejects exact noncanonical destinations behind code-span labels in %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test("accepts canonical encoded destinations behind code-span labels", () => {
    expect(
      validateTopikContent(
        "![Inline `]`](%C3%A9.png)\n\n![Reference `[`][id]\n\n[id]: %C3%A9.png\n",
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("rejects a multiline external entity without borrowing a later escaped construct", () => {
    const source =
      "![Multiline](\n  https://example.com/a&amp;b\n) \\![fake](https://example.com/a&b)";
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", type: "image.src" }),
      ]),
    });
  });

  test("validates exact continuation-line definition destinations independently from titles", () => {
    for (const source of [
      "![Hero][id]\n\n[id]:\n  é.png\n",
      '![Hero][id]\n\n[id]:\n  &eacute;.png\n  "Title"\n',
    ]) {
      expect(validateTopikContent(source)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
        ]),
      });
    }
    expect(validateTopikContent('![Hero][id]\n\n[id]:\n  hero.png\n  "Title"\n')).toMatchObject({
      valid: true,
      errors: [],
    });
  });
});

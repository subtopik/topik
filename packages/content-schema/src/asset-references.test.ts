import { describe, expect, test } from "vite-plus/test";
import {
  extractTopikAssetOccurrences,
  rewriteTopikAssetOccurrences,
  topikAssetReferenceSlots,
  validateTopikAssetReference,
} from "./asset-references";

describe("topik-asset-reference-v1 occurrence registry", () => {
  test("retains duplicate occurrences and occurrence-specific semantics", () => {
    const source = [
      '![First](assets/hero.png "First title")',
      "![Second](assets/hero.png)",
      '{% figure src="assets/hero.png" darkSrc="assets/hero-dark.png" alt="Hero" caption="Caption" /%}',
    ].join("\n\n");
    const occurrences = extractTopikAssetOccurrences(source);

    expect(occurrences).toHaveLength(4);
    expect(new Set(occurrences.map((value) => value.position)).size).toBe(4);
    expect(occurrences[2].position).toMatch(/\/attributes\/src$/u);
    expect(occurrences[3].position).toMatch(/\/attributes\/darkSrc$/u);
    expect(occurrences[2].treePath).toEqual(occurrences[3].treePath);
    expect(occurrences.filter((value) => value.reference === "assets/hero.png")).toHaveLength(3);
    expect(occurrences[0].semantics).toMatchObject({ alt: "First", title: "First title" });
    expect(occurrences[2].semantics).toMatchObject({
      alt: "Hero",
      caption: "Caption",
      lightDarkRole: "light",
    });
    expect(occurrences[3].semantics.lightDarkRole).toBe("dark");
  });

  test("keeps external HTTPS exact and marks unsafe schemes", () => {
    const occurrences = extractTopikAssetOccurrences(
      [
        "![safe](https://example.com/a.png?q=1#hero)",
        "![bad](http://example.com/a.png)",
        "![backslash](https://example.com\\\\evil.png)",
      ].join("\n\n"),
    );
    expect(occurrences[0]).toMatchObject({
      kind: "external-https",
      reference: "https://example.com/a.png?q=1#hero",
    });
    expect(occurrences[1].kind).toBe("unsafe");
    expect(occurrences[2].kind).toBe("unsafe");
  });

  test.each([
    ["http://example.com/file.pdf", "unsafe"],
    ["https://user:secret@example.com/file.pdf", "unsafe"],
    ["https://example.com/file.pdf", "external-https"],
  ])("retains the effective destination for autolink %s", (reference, kind) => {
    expect(
      extractTopikAssetOccurrences(`<${reference}>`, { includeGenericLinkCandidates: true }),
    ).toMatchObject([{ reference, parsedReference: reference, kind, slot: "link.href" }]);
  });

  test("keeps every effective autolink destination paired in a mixed paragraph", () => {
    expect(
      extractTopikAssetOccurrences(
        "<person@example.com> <http://example.com/file.pdf> <https://example.com/file.pdf>",
        { includeGenericLinkCandidates: true },
      ).map(({ kind, reference }) => ({ kind, reference })),
    ).toEqual([
      { kind: "unsafe", reference: "mailto:person@example.com" },
      { kind: "unsafe", reference: "http://example.com/file.pdf" },
      { kind: "external-https", reference: "https://example.com/file.pdf" },
    ]);
  });

  test.each([
    "assets%2Fhero.png",
    "assets%2fhero.png",
    "%2E%2E/hero.png",
    "é.png",
    "/hero.png",
    "//example.com/hero.png",
    "file:///hero.png",
  ])("rejects noncanonical reference bytes %s", (reference) => {
    expect(validateTopikAssetReference(reference)).toMatchObject({ valid: false, kind: "unsafe" });
  });

  test("accepts canonical local and credential-free HTTPS references", () => {
    expect(validateTopikAssetReference("assets/caf%C3%A9.png")).toEqual({
      valid: true,
      kind: "local",
      decodedPath: "assets/café.png",
    });
    expect(validateTopikAssetReference("https://example.com/a.png?q=1#hero")).toEqual({
      valid: true,
      kind: "external-https",
    });
  });

  test("accepts exact source-relative dot segments for compiler containment resolution", () => {
    expect(validateTopikAssetReference("./hero.png")).toEqual({
      valid: true,
      kind: "local",
      decodedPath: "./hero.png",
    });
    expect(validateTopikAssetReference("../shared/hero.png")).toEqual({
      valid: true,
      kind: "local",
      decodedPath: "../shared/hero.png",
    });
  });

  test("accepts only exact compiler-generated references", () => {
    const generated = `auto-v1-${"a".repeat(52)}`;
    expect(validateTopikAssetReference("asset:company-logo")).toMatchObject({
      valid: false,
      kind: "unsafe",
    });
    expect(validateTopikAssetReference(`asset:${generated}`)).toEqual({
      valid: true,
      kind: "asset",
      name: generated,
    });
    expect(validateTopikAssetReference("asset:auto-v1-short")).toMatchObject({
      valid: false,
      kind: "unsafe",
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
  ])("classifies reserved scheme spelling %s before generic-link fallback", (reference) => {
    expect(extractTopikAssetOccurrences(`[Download](${reference})\n`)).toMatchObject([
      { slot: "link.href", kind: "reserved-asset" },
    ]);
  });

  test("retains original Markdown destination bytes before parser normalization", () => {
    expect(extractTopikAssetOccurrences("![raw](é.png)\n")[0]).toMatchObject({
      reference: "é.png",
      kind: "unsafe",
    });
    expect(extractTopikAssetOccurrences("![canonical](%C3%A9.png)\n")[0]).toMatchObject({
      reference: "%C3%A9.png",
      kind: "local",
    });
    expect(extractTopikAssetOccurrences("![entity](&eacute;.png)\n")[0]).toMatchObject({
      reference: "&eacute;.png",
      kind: "unsafe",
    });
    expect(extractTopikAssetOccurrences("![escaped](hero\\.png)\n")[0]).toMatchObject({
      reference: "hero\\.png",
      kind: "unsafe",
    });
  });

  test("retains exact destinations behind balanced nested image and link labels", () => {
    const source = [
      "![Inline [raw]](é.png)",
      "![Reference [entity]][image-id]",
      "[Inline [escaped]](manual\\.bin)",
      "[Reference [raw]][download-id]",
      "",
      "[image-id]: &eacute;.png",
      "[download-id]: é.bin",
      "[unused]: &eacute;.png",
    ].join("\n");

    expect(
      extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true }).map(
        ({ kind, reference, slot }) => ({ kind, reference, slot }),
      ),
    ).toEqual([
      { kind: "unsafe", reference: "é.png", slot: "image.src" },
      { kind: "unsafe", reference: "&eacute;.png", slot: "image.src" },
      { kind: "unsafe", reference: "manual\\.bin", slot: "link.href" },
      { kind: "unsafe", reference: "é.bin", slot: "link.href" },
    ]);
  });

  test("retains exact destinations when image and link labels contain code-span brackets", () => {
    const source = [
      "![Inline `]`](&eacute;.png)",
      "![Reference `[`][image-id]",
      "[Inline `]`](manual\\.bin)",
      "[Reference `[`][download-id]",
      "",
      "[image-id]: é.png",
      "[download-id]: é.bin",
    ].join("\n");

    expect(
      extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true }).map(
        ({ kind, reference, slot }) => ({ kind, reference, slot }),
      ),
    ).toEqual([
      { kind: "unsafe", reference: "&eacute;.png", slot: "image.src" },
      { kind: "unsafe", reference: "é.png", slot: "image.src" },
      { kind: "unsafe", reference: "manual\\.bin", slot: "link.href" },
      { kind: "unsafe", reference: "é.bin", slot: "link.href" },
    ]);
  });

  test("retains exact multiline Markdown destinations", () => {
    expect(extractTopikAssetOccurrences("![Multiline](\n  é.png\n)\n")).toMatchObject([
      { reference: "é.png", parsedReference: "%C3%A9.png", kind: "unsafe" },
    ]);
  });

  test("pairs a multiline destination only with its own parser node", () => {
    const source =
      "![Multiline](\n  https://example.com/a&amp;b\n) \\![fake](https://example.com/a&b)";
    expect(extractTopikAssetOccurrences(source)).toMatchObject([
      {
        reference: "https://example.com/a&amp;b",
        parsedReference: "https://example.com/a&b",
        kind: "unsafe",
      },
    ]);
  });

  test("ignores a parser-ineligible construct instead of associating it with a parser node", () => {
    const unsupported = `${"(".repeat(33)}x${")".repeat(33)}`;
    expect(
      extractTopikAssetOccurrences(`![not-parsed](${unsupported}) ![real](%C3%A9.png)`),
    ).toMatchObject([{ reference: "%C3%A9.png", parsedReference: "%C3%A9.png", kind: "local" }]);
  });

  test("never borrows exact-source proof from an arbitrary Markdoc attribute", () => {
    const source =
      '![x][id] {% callout title="![x](%C3%A9.png)" %}foo{% /callout %}\n\n> [id]: é.png';
    expect(extractTopikAssetOccurrences(source)).toMatchObject([
      { reference: "", parsedReference: "%C3%A9.png", kind: "unsafe", slot: "image.src" },
    ]);
  });

  test("an arbitrary Markdoc attribute neither disturbs nor participates in rewriting", () => {
    const source =
      '![real](%C3%A9.png) {% callout title="![attribute](other.png)" %}foo{% /callout %}';
    expect(extractTopikAssetOccurrences(source)).toMatchObject([
      { reference: "%C3%A9.png", parsedReference: "%C3%A9.png", kind: "local" },
    ]);
    const rewritten = rewriteTopikAssetOccurrences(source, () => "replacement.png");
    expect(rewritten).toContain("![real](replacement.png)");
    expect(rewritten).toContain('title="![attribute](other.png)"');
  });

  test.each(["before", "after"])(
    "fails closed when an unavailable equivalent construct appears %s a parser node",
    (placement) => {
      const unavailable = "![unavailable][id]";
      const parsed = "![real](%C3%A9.png)";
      const paragraph =
        placement === "before" ? `${unavailable} ${parsed}` : `${parsed} ${unavailable}`;
      const source = `${paragraph}\n\n> [id]: %C3%A9.png`;
      expect(extractTopikAssetOccurrences(source)).toMatchObject([
        { reference: "", parsedReference: "%C3%A9.png", kind: "unsafe" },
        { reference: "", parsedReference: "%C3%A9.png", kind: "unsafe" },
      ]);
    },
  );

  test("keeps canonical destinations behind balanced nested labels", () => {
    const source = [
      "![Inline [canonical]](%C3%A9.png)",
      "![Reference [canonical]][image-id]",
      "[Download [canonical]](manual.bin)",
      "[Reference download [canonical]][download-id]",
      "",
      "[image-id]: %C3%A9.png",
      "[download-id]: manual.bin",
    ].join("\n");
    expect(
      extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true }).map(
        ({ kind, reference }) => ({ kind, reference }),
      ),
    ).toEqual([
      { kind: "local", reference: "%C3%A9.png" },
      { kind: "local", reference: "%C3%A9.png" },
      { kind: "local", reference: "manual.bin" },
      { kind: "local", reference: "manual.bin" },
    ]);
  });

  test("keeps canonical destinations behind code-span labels", () => {
    const source = [
      "![Inline `]`](%C3%A9.png)",
      "![Reference `[`][image-id]",
      "[Download `]`](manual.bin)",
      "[Reference download `[`][download-id]",
      "",
      "[image-id]: %C3%A9.png",
      "[download-id]: manual.bin",
    ].join("\n");
    expect(
      extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true }).map(
        ({ kind, reference }) => ({ kind, reference }),
      ),
    ).toEqual([
      { kind: "local", reference: "%C3%A9.png" },
      { kind: "local", reference: "%C3%A9.png" },
      { kind: "local", reference: "manual.bin" },
      { kind: "local", reference: "manual.bin" },
    ]);
  });

  test("retains an exact image destination nested inside a link label", () => {
    expect(
      extractTopikAssetOccurrences("[![Nested image](é.png)](manual.bin)", {
        includeGenericLinkCandidates: true,
      }),
    ).toMatchObject([
      { slot: "link.href", reference: "manual.bin", kind: "local" },
      { slot: "image.src", reference: "é.png", kind: "unsafe" },
    ]);
  });

  test("retains exact destinations for full, collapsed, shortcut, and repeated image references", () => {
    const source = [
      "![Canonical][canonical]",
      "![Raw][raw]",
      "![Raw again][raw]",
      "![Collapsed][]",
      "![Shortcut]",
      "",
      "[raw]: é.png",
      "[collapsed]: é.png",
      "[shortcut]: é.png",
      "[canonical]: %C3%A9.png",
    ].join("\n");

    expect(extractTopikAssetOccurrences(source).map((occurrence) => occurrence.reference)).toEqual([
      "%C3%A9.png",
      "é.png",
      "é.png",
      "é.png",
      "é.png",
    ]);
  });

  test("does not classify an unused invalid definition or confuse definitions with equal parsed URLs", () => {
    const source = [
      "![Good][good]",
      "",
      "[unused]: &eacute;.png",
      "[same-parsed]: é.png",
      "[good]: %C3%A9.png",
    ].join("\n");

    expect(extractTopikAssetOccurrences(source)).toMatchObject([
      { reference: "%C3%A9.png", kind: "local" },
    ]);
  });

  test("retains HTML entities and Markdown escapes from used reference definitions", () => {
    expect(extractTopikAssetOccurrences("![Entity][id]\n\n[id]: &eacute;.png\n")).toMatchObject([
      { reference: "&eacute;.png", kind: "unsafe" },
    ]);
    expect(extractTopikAssetOccurrences("![Escaped][id]\n\n[id]: hero\\.png\n")).toMatchObject([
      { reference: "hero\\.png", kind: "unsafe" },
    ]);
  });

  test.each([1, 2, 3])(
    "retains a raw continuation-line reference destination indented %i spaces",
    (indentation) => {
      const source = `![Raw][id]\n\n[id]:\n${" ".repeat(indentation)}é.png\n`;
      expect(extractTopikAssetOccurrences(source)).toMatchObject([
        { reference: "é.png", kind: "unsafe" },
      ]);
    },
  );

  test("retains an entity continuation destination and ignores its separate title", () => {
    expect(
      extractTopikAssetOccurrences('![Entity][id]\n\n[id]:\n  &eacute;.png\n  "Entity title"\n'),
    ).toMatchObject([{ reference: "&eacute;.png", kind: "unsafe" }]);
    expect(
      extractTopikAssetOccurrences('![Canonical][id]\n\n[id]:\n  good.png\n  "Canonical title"\n'),
    ).toMatchObject([{ reference: "good.png", kind: "local" }]);
  });

  test("classifies generic links only after a compiler proves the file path", () => {
    const source = '[download](files/manual.bin)\n\n{% card title="X" href="files/hidden.bin" /%}';
    expect(extractTopikAssetOccurrences(source)).toHaveLength(0);
    expect(
      extractTopikAssetOccurrences(source, { provenDownloadPaths: ["files/manual.bin"] }),
    ).toHaveLength(1);
    expect(topikAssetReferenceSlots.some((slot) => slot.slot === "link.href")).toBe(true);
  });

  test("rewrites only declared slots", () => {
    const source = '![image](old.png)\n\n{% card title="leave" href="custom:leave" /%}';
    const rewritten = rewriteTopikAssetOccurrences(source, () => "new.png");
    expect(rewritten).toContain("![image](new.png)");
    expect(rewritten).toContain('title="leave"');
    expect(rewritten).toContain('href="custom:leave"');
  });

  test("rewrites light and dark figure slots independently", () => {
    const source =
      '{% figure src="images/old-light.png" darkSrc="images/old-dark.png" alt="Theme preview" /%}';
    const rewritten = rewriteTopikAssetOccurrences(source, (occurrence) =>
      occurrence.slot === "figure.src" ? "images/light.png" : "images/dark.png",
    );
    expect(rewritten).toContain('src="images/light.png"');
    expect(rewritten).toContain('darkSrc="images/dark.png"');
  });
});

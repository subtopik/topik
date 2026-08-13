import Markdoc, { type Config } from "@markdoc/markdoc";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  extractTopikAssetOccurrences,
  topikAssetReferenceSlots,
  validateTopikAssetReference,
} from "./asset-references";
import { mergeTopikMarkdocConfig } from "./config";
import { rewriteTopikAssetOccurrences } from "./rewrite";

const unsafeDiagnosticFiles = [
  "/tmp/SENSITIVE_DIRECTORY/lesson.md",
  String.raw`C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\\server\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md`,
  String.raw`\Device\HarddiskVolume1\SENSITIVE_DIRECTORY\lesson.md`,
  "https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
] as const;

const ambiguousDiagnosticFiles = [
  " https://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https%3A%2F%2Fuser%3AFILE_CREDENTIAL_SENTINEL%40example.com%2FSENSITIVE_DIRECTORY%2Flesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL",
  "https%253A%252F%252Fuser%253AFILE_CREDENTIAL_SENTINEL%2540example.com%252FSENSITIVE_DIRECTORY%252Flesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL",
  "/tmp/SENSITIVE_DIRECTORY%2Flesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL",
  String.raw`C:\SENSITIVE_DIRECTORY%5Clesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL`,
  String.raw`\\server\SENSITIVE_DIRECTORY%5Clesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL`,
  String.raw`\Users\SENSITIVE_DIRECTORY\lesson.md%3Ftoken%3DQUERY_SENTINEL%23FRAGMENT_SENTINEL`,
  String.raw`\?\C:\SENSITIVE_DIRECTORY\lesson.md%253Ftoken%253DQUERY_SENTINEL%2523FRAGMENT_SENTINEL`,
  "https://example.com/SENSITIVE_DIRECTORY%2Flesson.md?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
  "https://user:%46ILE_CREDENTIAL_SENTINEL@example.com/lesson.md",
  "https://user:%46ILE_CREDENTIAL_SENTINEL@[?token=%51UERY_SENTINEL#%46RAGMENT_SENTINEL",
  "https ://user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&amp;colon;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "https&#58;//user:FILE_CREDENTIAL_SENTINEL@example.com/SENSITIVE_DIRECTORY/lesson.md",
  "\u0085/tmp/SENSITIVE_DIRECTORY/lesson.md",
  "\u200B/tmp/SENSITIVE_DIRECTORY/lesson.md",
  "\u202E/tmp/SENSITIVE_DIRECTORY/lesson.md",
] as const;

describe("topik-asset-reference-v1 occurrence registry", () => {
  test.each(["constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "refuses an unregistered inherited tag %s before replacement",
    (name) => {
      const source = `{% ${name} %}ordinary child{% /${name} %}\n![Asset](old.png)`;
      const replace = vi.fn(() => "new.png");
      const result = rewriteTopikAssetOccurrences(source, replace);

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("content");
      expect(replace).not.toHaveBeenCalled();
      expect(JSON.stringify(result.diagnostics)).not.toContain("ordinary child");
    },
  );

  test.each([
    {
      source: "{% partial file=$which /%}",
      config: {
        variables: { which: "part.md" },
        partials: { "part.md": Markdoc.parse("Top-level child") },
      },
    },
    {
      source: "{% partial file=$selection.which /%}",
      config: {
        variables: { selection: { which: "part.md" } },
        partials: { "part.md": Markdoc.parse("Nested-path child") },
      },
    },
    {
      source: '{% partial file="outer.md" variables={which: $target} /%}',
      config: {
        variables: { target: "inner.md" },
        partials: {
          "outer.md": Markdoc.parse("{% partial file=$which /%}"),
          "inner.md": Markdoc.parse("Scoped child"),
        },
      },
    },
  ])("rewrites valid variable-selected partial source", ({ config, source }) => {
    const replace = vi.fn(() => "replacement");
    const result = rewriteTopikAssetOccurrences(source, replace, { config });

    expect(result).toMatchObject({ ok: true, source });
    expect(replace).not.toHaveBeenCalled();
  });

  test.each([undefined, 42, "missing.md"])(
    "refuses an unresolved variable-selected partial before replacement",
    (which) => {
      const source = "{% partial file=$which /%}\n![Asset](old.png)";
      const replace = vi.fn(() => "replacement");
      const result = rewriteTopikAssetOccurrences(source, replace, {
        config: {
          variables: { which },
          partials: { "part.md": Markdoc.parse("Safe") },
        },
      });

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("content");
      expect(replace).not.toHaveBeenCalled();
    },
  );

  test("refuses an invalid reachable partial before replacement or formatting", () => {
    const source = '{% partial file="bad.md" /%}\n![Asset](old.png)';
    const extensionValidator = vi.fn(() => []);
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, {
      config: {
        partials: {
          "bad.md": Markdoc.parse("{% attack /%}\n{% quiz %}ordinary child{% /quiz %}"),
        },
        tags: { attack: { render: "div", validate: extensionValidator } },
      },
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("content");
    expect(JSON.stringify(result.diagnostics)).not.toContain("ordinary child");
    expect(extensionValidator).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  test.each([
    "http://example.com/file.pdf",
    "https://user:PRIVATE_VALUE_SENTINEL@example.com/file.pdf",
    `asset:auto-v1-${"a".repeat(52)}`,
  ])("refuses an unsafe partial link before replacement", (href) => {
    const source = '{% partial file="part.md" /%}\n![Asset](old.png)';
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, {
      config: { partials: { "part.md": Markdoc.parse(`[Download](${href})`) } },
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("content");
    expect(replace).not.toHaveBeenCalled();
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  test("refuses canonical errors before extension validation, replacement, or formatting", () => {
    const source = "{% attack /%}\n{% quiz %}ordinary child{% /quiz %}";
    const extensionValidator = vi.fn((_node, config: Config) => {
      const quiz = config.tags?.quiz as Record<string, unknown>;
      Reflect.set(quiz, "validate", () => []);
      return [];
    });
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, {
      config: { tags: { attack: { render: "div", validate: extensionValidator } } },
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("content");
    expect(extensionValidator).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  test("refuses a real Asset when a reachable-partial validator retargets a later sibling", () => {
    const source = '{% partial file="attack.md" /%}\n![Asset](old.png)';
    const extensionValidator = vi.fn((_node, config: Config) => {
      const root = config.validation?.parents?.[0];
      const victim =
        root === undefined
          ? undefined
          : [root, ...root.walk()].find((node) => node.tag === "victim");
      if (victim !== undefined) victim.attributes.bad = false;
      return [];
    });
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, {
      config: {
        partials: {
          "attack.md": Markdoc.parse("{% attack /%}\n{% victim bad=true /%}"),
        },
        tags: {
          attack: { render: "span", selfClosing: true, validate: extensionValidator },
          victim: {
            render: "span",
            selfClosing: true,
            attributes: {
              bad: {
                type: Boolean,
                required: true,
                matches: [false] as unknown as string[],
              },
            },
          },
        },
      },
    });

    expect(extensionValidator).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("content");
    expect(replace).not.toHaveBeenCalled();
  });

  test("mutated merged schemas cannot weaken validation before rewrite or replacement", () => {
    const source = "{% quiz %}ordinary child{% /quiz %}";
    const config = mergeTopikMarkdocConfig();
    const replace = vi.fn(() => "new.png");
    const quiz = config.tags?.quiz as Record<string, unknown>;
    const originalValidate = quiz.validate;

    try {
      Reflect.set(quiz, "validate", () => []);
      Reflect.set(config, "tags", { quiz: { render: "TopikQuiz", validate: () => [] } });

      const result = rewriteTopikAssetOccurrences(source, replace, { config });

      expect(result).toMatchObject({ ok: false, source });
      expect(result).not.toHaveProperty("content");
      expect(replace).not.toHaveBeenCalled();
    } finally {
      Reflect.set(quiz, "validate", originalValidate);
    }
  });

  test("canonical validation cannot be replaced before rewrite or replacement", () => {
    const source = "{% quiz %}{% /quiz %}";
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, {
      config: { tags: { quiz: { render: "TopikQuiz" } } },
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("content");
    expect(replace).not.toHaveBeenCalled();
  });

  test("refuses unsupported source before replacement or formatting", () => {
    const source = '  {% mystery private="opaque" %}\r\n![child](old.png)\r\n{% /mystery %}  ';
    const replace = vi.fn(() => "new.png");

    const result = rewriteTopikAssetOccurrences(source, replace);

    expect(result).toMatchObject({ ok: false, source });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "tag-undefined", level: "critical" })]),
    );
    expect(result).not.toHaveProperty("content");
    expect(replace).not.toHaveBeenCalled();
  });

  test("keeps sensitive source and absolute paths out of rewrite-refusal diagnostics", () => {
    const sentinel = "SENSITIVE_DIRECTORY";
    const source = "![x](é.png)";
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, {
      file: `/tmp/${sentinel}/lesson.md`,
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", file: "lesson.md" }),
      ]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(sentinel);
    expect(JSON.stringify(result.diagnostics)).not.toContain("/tmp/");
    expect(replace).not.toHaveBeenCalled();
  });

  test("does not expose invalid authored enum values through rewrite refusal", () => {
    const sentinel = "PRIVATE_VALUE_SENTINEL";
    const source = `{% callout variant="${sentinel}" %}child{% /callout %}`;
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, {
      file: "/tmp/SENSITIVE_DIRECTORY/lesson.md",
    });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("content");
    expect(replace).not.toHaveBeenCalled();
    expect(JSON.stringify(result.diagnostics)).not.toContain(sentinel);
    expect(JSON.stringify(result.diagnostics)).not.toContain("SENSITIVE_DIRECTORY");
    expect(JSON.stringify(result.diagnostics)).not.toContain(source);
  });

  test.each(unsafeDiagnosticFiles)("sanitizes rewrite-refusal file label %s", (file) => {
    const source = '{% callout variant="PRIVATE_VALUE_SENTINEL" %}child{% /callout %}';
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, { file });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("content");
    expect(replace).not.toHaveBeenCalled();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ file: "lesson.md", message: "An attribute has an invalid value." }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u,
    );
  });

  test.each(ambiguousDiagnosticFiles)("fails an ambiguous rewrite label closed", (file) => {
    const source = '{% callout variant="PRIVATE_VALUE_SENTINEL" /%}';
    const replace = vi.fn(() => "new.png");
    const result = rewriteTopikAssetOccurrences(source, replace, { file });

    expect(result).toMatchObject({ ok: false, source });
    expect(result).not.toHaveProperty("content");
    expect(replace).not.toHaveBeenCalled();
    expect(result.diagnostics).toEqual([expect.objectContaining({ file: "content" })]);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL|%2F|%25/iu,
    );
  });

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

  test.each([
    ['"title (detail)"', "title (detail)"],
    ["'title (detail)'", "title (detail)"],
    ["(title detail)", "title detail"],
  ])("pairs and rewrites Markdoc inline title form %s", (titleSource, title) => {
    const source = [`![Hero](hero.png ${titleSource})`, `[Manual](manual.bin ${titleSource})`].join(
      "\n\n",
    );
    const options = { provenDownloadPaths: ["manual.bin"] } as const;
    expect(extractTopikAssetOccurrences(source, options)).toMatchObject([
      {
        slot: "image.src",
        reference: "hero.png",
        parsedReference: "hero.png",
        kind: "local",
        semantics: { title },
      },
      {
        slot: "link.href",
        reference: "manual.bin",
        parsedReference: "manual.bin",
        kind: "local",
        semantics: { title, linkLabel: "Manual" },
      },
    ]);

    const rewritten = rewriteTopikAssetOccurrences(
      source,
      (occurrence) =>
        occurrence.slot === "image.src" ? "compiled-hero.png" : "compiled-manual.bin",
      options,
    );
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    expect(rewritten.content).toContain(`![Hero](compiled-hero.png "${title}")`);
    expect(rewritten.content).toContain(`[Manual](compiled-manual.bin "${title}")`);
  });

  test.each([
    ['"title \\"detail\\" (v1)"', 'title "detail" (v1)'],
    [`'title "detail" (v1)'`, 'title "detail" (v1)'],
    [`(title "detail" v1)`, 'title "detail" v1'],
    [`'title \\'detail\\' "quote"'`, `title 'detail' "quote"`],
    [`(title \\) detail "quote")`, `title ) detail "quote"`],
    ['"title &quot;detail&quot; (v1)"', 'title "detail" (v1)'],
    ['"title\n&quot;detail&quot; (v1)"', 'title\n"detail" (v1)'],
    ['"title \\\\ path"', "title \\ path"],
    ['"title &amp;quot; literal"', "title &quot; literal"],
  ])("preserves decoded inline title semantics while rewriting %s", (titleSource, title) => {
    const source = [`![Hero](hero.png ${titleSource})`, `[Manual](manual.bin ${titleSource})`].join(
      "\n\n",
    );
    const before = extractTopikAssetOccurrences(source, {
      provenDownloadPaths: ["manual.bin"],
    });
    expect(before.map((occurrence) => occurrence.semantics.title)).toEqual([title, title]);

    const rewritten = rewriteTopikAssetOccurrences(
      source,
      (occurrence) =>
        occurrence.slot === "image.src" ? "compiled-hero.png" : "compiled-manual.bin",
      { provenDownloadPaths: ["manual.bin"] },
    );
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    const after = extractTopikAssetOccurrences(rewritten.content, {
      provenDownloadPaths: ["compiled-manual.bin"],
    });
    expect(after).toMatchObject([
      { slot: "image.src", reference: "compiled-hero.png", kind: "local" },
      { slot: "link.href", reference: "compiled-manual.bin", kind: "local" },
    ]);
    expect(after.map((occurrence) => occurrence.semantics.title)).toEqual([title, title]);
  });

  test("preserves unrelated navigation title semantics when rewriting an Asset destination", () => {
    const source =
      '[Guide](guide.md "navigation \\"title\\"")\n\n![Hero](hero.png "image \\"title\\"")';
    const before = extractTopikAssetOccurrences(source, {
      includeGenericLinkCandidates: true,
    });
    const rewritten = rewriteTopikAssetOccurrences(
      source,
      (occurrence) =>
        occurrence.slot === "image.src" ? "compiled-hero.png" : occurrence.reference,
      { includeGenericLinkCandidates: true },
    );
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    const after = extractTopikAssetOccurrences(rewritten.content, {
      includeGenericLinkCandidates: true,
    });

    expect(before.map((occurrence) => occurrence.semantics.title)).toEqual([
      'navigation "title"',
      'image "title"',
    ]);
    expect(after).toMatchObject([
      { slot: "link.href", reference: "guide.md", semantics: { title: 'navigation "title"' } },
      {
        slot: "image.src",
        reference: "compiled-hero.png",
        semantics: { title: 'image "title"' },
      },
    ]);
  });

  test("does not borrow exact-source proof from an unsupported nested parenthesized title", () => {
    const source = "![unsupported](hero.png (title (detail))) ![real](%C3%A9.png)";
    expect(extractTopikAssetOccurrences(source)).toMatchObject([
      { reference: "%C3%A9.png", parsedReference: "%C3%A9.png", kind: "local" },
    ]);
  });

  test("does not borrow exact-source proof across an unterminated escaped-quote title", () => {
    const source = '![unsupported](hero.png "title \\"detail\\" (v1)) ![real](%C3%A9.png)';
    expect(extractTopikAssetOccurrences(source)).toMatchObject([
      { reference: "%C3%A9.png", parsedReference: "%C3%A9.png", kind: "local" },
    ]);
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

  test("accepts credential-free mixed-case HTTPS and preserves occurrence spelling", () => {
    expect(validateTopikAssetReference("HtTpS://example.com/a.png?q=1#hero")).toEqual({
      valid: true,
      kind: "external-https",
    });
    const source = [
      "![Image](HtTpS://example.com/image.png)",
      "[Download](hTTps://example.com/manual.pdf)",
      "<HTTPS://example.com/autolink.pdf>",
      '{% figure src="HTtPs://example.com/light.png" darkSrc="htTPs://example.com/dark.png" alt="Theme" /%}',
    ].join("\n\n");

    expect(
      extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true }),
    ).toMatchObject([
      { slot: "image.src", reference: "HtTpS://example.com/image.png", kind: "external-https" },
      {
        slot: "link.href",
        reference: "hTTps://example.com/manual.pdf",
        kind: "external-https",
      },
      {
        slot: "link.href",
        reference: "HTTPS://example.com/autolink.pdf",
        kind: "external-https",
      },
      {
        slot: "figure.src",
        reference: "HTtPs://example.com/light.png",
        kind: "external-https",
      },
      {
        slot: "figure.darkSrc",
        reference: "htTPs://example.com/dark.png",
        kind: "external-https",
      },
    ]);
  });

  test.each([
    "HtTp://example.com/file.pdf",
    "hTtPs://user:secret@example.com/file.pdf",
    "//example.com/file.pdf",
    "HtTpS://[invalid",
  ])("rejects unsafe mixed-case external form %s", (reference) => {
    expect(validateTopikAssetReference(reference)).toMatchObject({
      valid: false,
      kind: "unsafe",
      failureKind: "external",
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

  test("accepts only canonical full-SHA-256 base32 Asset references", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    for (const finalSymbol of alphabet) {
      const reference = `asset:auto-v1-${"a".repeat(51)}${finalSymbol}`;
      expect(validateTopikAssetReference(reference).valid, reference).toBe(
        finalSymbol === "a" || finalSymbol === "q",
      );
    }
    for (const reference of [
      `asset:auto-v1-${"a".repeat(51)}`,
      `asset:auto-v1-${"a".repeat(53)}`,
      `asset:auto-v1-${"a".repeat(51)}0`,
      `asset:auto-v1-${"a".repeat(51)}A`,
      `asset:auto-v1-${"a".repeat(52)}=`,
      `ASSET:auto-v1-${"a".repeat(52)}`,
    ]) {
      expect(validateTopikAssetReference(reference).valid, reference).toBe(false);
    }
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
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    expect(rewritten.content).toContain("![real](replacement.png)");
    expect(rewritten.content).toContain('title="![attribute](other.png)"');
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

  test.each(["before", "after"])(
    "retains effective link destinations when exact pairing is unavailable %s a parser node",
    (placement) => {
      const unavailable = "[Unavailable][id]";
      const parsed = "[Download](https://example.com/file.pdf)";
      const paragraph =
        placement === "before" ? `${unavailable} ${parsed}` : `${parsed} ${unavailable}`;
      const source = `${paragraph}\n\n> [id]: https://example.com/file.pdf`;
      expect(
        extractTopikAssetOccurrences(source, { includeGenericLinkCandidates: true }),
      ).toMatchObject([
        { reference: "", parsedReference: "https://example.com/file.pdf", kind: "unsafe" },
        { reference: "", parsedReference: "https://example.com/file.pdf", kind: "unsafe" },
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

  test("derives download meaning from every visible schema-supported inline label form", () => {
    const source = [
      "[`Manual`](manual.bin)",
      "[**API `Manual`**](manual.bin)",
      "[Reference `Manual`][manual]",
      "[![Manual icon](icon.png)](manual.bin)",
      "",
      "[manual]: manual.bin",
    ].join("\n");
    const labels = extractTopikAssetOccurrences(source, {
      provenDownloadPaths: ["manual.bin"],
    })
      .filter((occurrence) => occurrence.role === "download")
      .map((occurrence) => occurrence.semantics.linkLabel);

    expect(labels).toEqual(["Manual", "API Manual", "Reference Manual", "Manual icon"]);
  });

  test("does not invent visible download meaning from a decorative nested image", () => {
    const download = extractTopikAssetOccurrences("[![](icon.png)](manual.bin)", {
      provenDownloadPaths: ["manual.bin"],
    }).find((occurrence) => occurrence.role === "download");
    expect(download?.semantics.linkLabel).toBe("");
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
    const source = '![image](old.png)\n\n{% card title="leave" href="/leave" /%}';
    const rewritten = rewriteTopikAssetOccurrences(source, () => "new.png");
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    expect(rewritten.content).toContain("![image](new.png)");
    expect(rewritten.content).toContain('title="leave"');
    expect(rewritten.content).toContain('href="/leave"');
  });

  test("rewrites light and dark figure slots independently", () => {
    const source =
      '{% figure src="images/old-light.png" darkSrc="images/old-dark.png" alt="Theme preview" /%}';
    const rewritten = rewriteTopikAssetOccurrences(source, (occurrence) =>
      occurrence.slot === "figure.src" ? "images/light.png" : "images/dark.png",
    );
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    expect(rewritten.content).toContain('src="images/light.png"');
    expect(rewritten.content).toContain('darkSrc="images/dark.png"');
  });
});

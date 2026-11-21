import { describe, expect, test, vi } from "vite-plus/test";
import {
  extractTopikAssetOccurrences,
  formatTopikContent,
  rewriteTopikAssetOccurrences,
  validateTopikContent,
  type TopikContentConfig,
} from "./index.js";

describe("source boundaries", () => {
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
    expect(validateTopikContent(result.content).ok).toBe(false);
    expect(validateTopikContent(result.content, { allowCompiledAssetReferences: true }).ok).toBe(
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
});

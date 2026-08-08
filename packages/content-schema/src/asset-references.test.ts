import { describe, expect, test } from "vite-plus/test";
import {
  extractTopikAssetOccurrences,
  rewriteTopikAssetOccurrences,
  topikAssetReferenceSlots,
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

  test("classifies generic links only through an explicit declaration or manifest path", () => {
    const source = '[download](files/manual.bin)\n\n{% card title="X" href="files/hidden.bin" /%}';
    expect(extractTopikAssetOccurrences(source)).toHaveLength(0);
    expect(
      extractTopikAssetOccurrences(source, { manifestPaths: ["files/manual.bin"] }),
    ).toHaveLength(1);
    expect(topikAssetReferenceSlots.some((slot) => slot.slot === "link.href")).toBe(true);
  });

  test("rewrites only declared slots", () => {
    const source = '![image](old.png)\n\n{% card title="asset:leave" href="asset:leave" /%}';
    const rewritten = rewriteTopikAssetOccurrences(source, () => "new.png");
    expect(rewritten).toContain("![image](new.png)");
    expect(rewritten).toContain('title="asset:leave"');
    expect(rewritten).toContain('href="asset:leave"');
  });

  test("rewrites light and dark figure slots independently", () => {
    const source = '{% figure src="asset:light" darkSrc="asset:dark" alt="Theme preview" /%}';
    const rewritten = rewriteTopikAssetOccurrences(source, (occurrence) =>
      occurrence.slot === "figure.src" ? "images/light.png" : "images/dark.png",
    );
    expect(rewritten).toContain('src="images/light.png"');
    expect(rewritten).toContain('darkSrc="images/dark.png"');
  });
});

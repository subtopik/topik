import { describe, expect, test } from "vite-plus/test";
import { analyzeTopikContent, validateTopikHref } from "./links";

describe("Topik links", () => {
  test("accepts supported internal, external, contact, and asset links", () => {
    for (const href of [
      "#overview",
      "/guide/setup#install",
      "./setup",
      "../intro",
      "https://example.com/docs",
      "http://localhost:3000",
      "mailto:docs@example.com",
      "tel:+123456789",
      "asset:0123456789abcdef",
    ]) {
      expect(validateTopikHref(href), href).toEqual([]);
    }
  });

  test("rejects empty, unsafe, unsupported, malformed, and protocol-relative links", () => {
    expect(validateTopikHref("")[0]?.id).toBe("link-href-empty");
    expect(validateTopikHref("javascript:alert(1)")[0]?.id).toBe("link-scheme-unsafe");
    expect(validateTopikHref("data:text/plain,test")[0]?.id).toBe("link-scheme-unsafe");
    expect(validateTopikHref("ftp://example.com")[0]?.id).toBe("link-scheme-unsupported");
    expect(validateTopikHref("//example.com")[0]?.id).toBe("link-url-protocol-relative");
    expect(validateTopikHref("https://")[0]?.id).toBe("link-url-invalid");
    expect(validateTopikHref("#%zz")[0]?.id).toBe("link-url-invalid");
  });

  test("rejects browser-normalized unsafe schemes and protocol-relative links", () => {
    for (const href of [
      "java\nscript:alert(1)",
      "data\r:text/plain,test",
      "\u0000javascript:alert(1)",
    ]) {
      expect(validateTopikHref(href)[0]?.id, JSON.stringify(href)).toBe("link-url-invalid");
    }

    for (const href of ["\\\\example.com", "/\\example.com", "\\/example.com", "\\\\topik.local"]) {
      expect(validateTopikHref(href)[0]?.id, JSON.stringify(href)).toBe(
        "link-url-protocol-relative",
      );
    }
  });

  test("extracts headings, Markdown links, cards, and source locations", () => {
    const result = analyzeTopikContent(
      [
        "# Intro",
        "",
        "[Setup](/setup#install)",
        "",
        '{% card title="API" href="https://example.com" /%}',
      ].join("\n"),
      { file: "intro.md" },
    );

    expect(result.headings).toEqual([
      expect.objectContaining({ file: "intro.md", id: "intro", level: 1, title: "Intro" }),
    ]);
    expect(result.links).toEqual([
      expect.objectContaining({ file: "intro.md", href: "/setup#install", kind: "link" }),
      expect.objectContaining({ file: "intro.md", href: "https://example.com", kind: "card" }),
    ]);
  });

  test("reports duplicate explicit heading IDs", () => {
    const result = analyzeTopikContent("## One {% #stable %}\n\n## Two {% #stable %}");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ id: "heading-id-duplicate", level: "error", type: "heading" }),
    ]);
  });
});

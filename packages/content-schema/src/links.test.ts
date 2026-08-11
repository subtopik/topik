import { describe, expect, test } from "vite-plus/test";
import { analyzeTopikContent, validateTopikHref } from "./links";

describe("Topik links", () => {
  test("accepts supported internal, external, and contact links", () => {
    for (const href of [
      "#overview",
      "/guide/setup#install",
      "./setup",
      "../intro",
      "https://example.com/docs",
      "http://localhost:3000",
      "mailto:docs@example.com",
      "tel:+123456789",
    ]) {
      expect(validateTopikHref(href), href).toEqual([]);
    }
  });

  test("rejects empty, unsafe, unsupported, malformed, and protocol-relative links", () => {
    expect(validateTopikHref("")[0]?.id).toBe("link-href-empty");
    expect(validateTopikHref("javascript:alert(1)")[0]?.id).toBe("link-scheme-unsafe");
    expect(validateTopikHref("data:text/plain,test")[0]?.id).toBe("link-scheme-unsafe");
    expect(validateTopikHref("ftp://example.com")[0]?.id).toBe("link-scheme-unsupported");
    expect(validateTopikHref("custom:opaque")[0]?.id).toBe("link-scheme-unsupported");
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

  test("returns safe generic diagnostics for malformed untrusted references", () => {
    const sentinel = "PRIVATE_VALUE";
    for (const href of [
      `https://user:${sentinel}@[`,
      `https://user:%50RIVATE_VALUE@[`,
      `hTtPs://user:${sentinel}@[`,
      `https://example.com/?token=${sentinel}#%zz`,
      `https://[${sentinel}`,
    ]) {
      const result = validateTopikHref(href);
      expect(result).toEqual([
        {
          id: "link-url-invalid",
          level: "error",
          message: "Link target is not a valid URL reference.",
        },
      ]);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(result)).not.toContain(href);
    }
  });

  test("never copies authored link structure into public diagnostics", () => {
    const cases = [
      ["PrivateValue:opaque", "link-scheme-unsupported", "privatevalue"],
      ["JaVaScRiPt:PRIVATE_VALUE", "link-scheme-unsafe", "javascript"],
      ["https://user:PRIVATE_VALUE@example.invalid/path", "link-url-credentials", "PRIVATE_VALUE"],
      [
        "hTtPs://user:%50RIVATE_VALUE@example.invalid/path",
        "link-url-credentials",
        "%50RIVATE_VALUE",
      ],
      ["https://example.invalid/?token=PRIVATE_VALUE#%zz", "link-url-invalid", "PRIVATE_VALUE"],
      ["hTtPs://[?token=PRIVATE_VALUE#fragment", "link-url-invalid", "PRIVATE_VALUE"],
    ] as const;

    for (const [href, id, sentinel] of cases) {
      const result = validateTopikHref(href);
      expect(result).toEqual([
        expect.objectContaining({ id, level: "error", message: expect.any(String) }),
      ]);
      const surfaces = [
        result.map(String).join("\n"),
        result.map((error) => error.message).join("\n"),
        JSON.stringify(result.map((error) => Object.keys(error))),
        JSON.stringify(result.map((error) => Object.values(error))),
        JSON.stringify(result),
      ].join("\n");
      expect(surfaces.toLowerCase()).not.toContain(sentinel.toLowerCase());
      expect(surfaces).not.toContain(href);
    }
  });

  test("enforces the canonical generated-name grammar in Asset hrefs", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    for (const finalSymbol of alphabet) {
      const href = `asset:auto-v1-${"a".repeat(51)}${finalSymbol}`;
      expect(validateTopikHref(href).length === 0, href).toBe(
        finalSymbol === "a" || finalSymbol === "q",
      );
    }
    for (const href of [
      `asset:auto-v1-${"a".repeat(51)}`,
      `asset:auto-v1-${"a".repeat(53)}`,
      `asset:auto-v1-${"a".repeat(51)}0`,
      `asset:auto-v1-${"a".repeat(51)}A`,
      `asset:auto-v1-${"a".repeat(52)}=`,
      `asset:AUTO-v1-${"a".repeat(52)}`,
    ]) {
      expect(validateTopikHref(href).length, href).toBeGreaterThan(0);
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

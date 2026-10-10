import { describe, expect, test } from "vite-plus/test";
import {
  TOPIK_RESOURCE_REFERENCE_VERSION,
  parseTopikResourceReference,
  serializeTopikResourceReference,
  type TopikResourceReference,
} from "./resource-references.js";
import { analyzeTopikContent, validateTopikBrowserHref, validateTopikHref } from "./links.js";
import { validateTopikContent } from "./validate.js";

describe("portable resource references", () => {
  test("parses resource names separately from their encoded query and fragment", () => {
    expect(TOPIK_RESOURCE_REFERENCE_VERSION).toBe(1);
    expect(
      parseTopikResourceReference(
        "ref://wiki-page/install-page?view=full&tag=a%2Fb&tag=c#setup%20details",
      ),
    ).toEqual({
      type: "WikiPage",
      name: "install-page",
      search: "?view=full&tag=a%2Fb&tag=c",
      hash: "setup%20details",
    });
    expect(parseTopikResourceReference("ref://guide/getting-started")).toEqual({
      type: "Guide",
      name: "getting-started",
      search: "",
      hash: "",
    });
  });

  test("canonicalizes scheme, kind, and percent-encoded resource names", () => {
    const parsed = parseTopikResourceReference("REF://Wiki-Page/%69nstall%2Dpage?x=%2f#%73etup");
    expect(parsed).toEqual({
      type: "WikiPage",
      name: "install-page",
      search: "?x=%2f",
      hash: "%73etup",
    });
    expect(serializeTopikResourceReference(parsed!)).toBe(
      "ref://wiki-page/install-page?x=%2f#%73etup",
    );
    expect(parseTopikResourceReference("ref://guide/name?#")).toEqual({
      type: "Guide",
      name: "name",
      search: "",
      hash: "",
    });
  });

  test("roundtrips both kinds without treating query paths or fragments as resource names", () => {
    for (const type of ["WikiPage", "Guide"] as const) {
      const reference: TopikResourceReference = {
        type,
        name: "stable-name-12",
        search: "?return=/docs/next&query=a+b",
        hash: "heading%2Fsubheading?mode=full",
      };
      expect(parseTopikResourceReference(serializeTopikResourceReference(reference))).toEqual(
        reference,
      );
    }
  });

  test("encodes Unicode fragments without changing their destination", () => {
    const reference = parseTopikResourceReference("ref://guide/install#安装");
    expect(reference?.hash).toBe("%E5%AE%89%E8%A3%85");
    expect(decodeURIComponent(reference!.hash)).toBe("安装");
    expect(serializeTopikResourceReference(reference!)).toBe(
      "ref://guide/install#%E5%AE%89%E8%A3%85",
    );
  });

  test("enforces the schema resource-name limit after percent decoding", () => {
    const longestName = "a".repeat(63);
    const reference: TopikResourceReference = {
      type: "Guide",
      name: longestName,
      search: "",
      hash: "",
    };
    expect(parseTopikResourceReference(`ref://guide/${longestName}`)).toEqual(reference);
    expect(parseTopikResourceReference(`ref://guide/${"%61".repeat(63)}`)).toEqual(reference);
    expect(serializeTopikResourceReference(reference)).toBe(`ref://guide/${longestName}`);
    expect(parseTopikResourceReference(`ref://guide/${"a".repeat(64)}`)).toBeNull();
    expect(parseTopikResourceReference(`ref://guide/${"%61".repeat(64)}`)).toBeNull();
    expect(() => serializeTopikResourceReference({ ...reference, name: "a".repeat(64) })).toThrow(
      "Resource reference is not valid",
    );
  });

  test.each([
    "./install.md",
    "https://guide/install",
    "ref:guide/install",
    "ref:://guide/install",
    "ref:///guide/install",
    "ref://course-page/install",
    "ref://article/guide/install",
    "ref://user:secret@guide/install",
    "ref://guide:123/install",
    "ref://guide/",
    "ref://guide/install/",
    "ref://guide/install/next",
    "ref://guide/UPPERCASE",
    "ref://guide/under_score",
    "ref://guide/-install",
    "ref://guide/install--next",
    "ref://guide/install%2Fnext",
    "ref://guide/%2E%2E",
    "ref://guide/%252F",
    "ref://guide/%FF",
    "ref://guide/install?token=%zz",
    "ref://guide/install#%zz",
    "ref://guide/install#%FF",
    "ref://guide/install#raw space",
    "ref://guide/install\n",
  ])("rejects malformed or unsupported reference %s", (href) => {
    expect(parseTopikResourceReference(href)).toBeNull();
  });

  test("rejects invalid serialization fields with fixed diagnostic text", () => {
    const reference: TopikResourceReference = {
      type: "Guide",
      name: "install",
      search: "",
      hash: "",
    };
    for (const override of [
      { type: "Article" },
      { name: "PRIVATE_VALUE" },
      { search: "token=PRIVATE_VALUE" },
      { search: "?token=PRIVATE_VALUE#heading" },
      { hash: "%zzPRIVATE_VALUE" },
    ]) {
      expect(() =>
        serializeTopikResourceReference({ ...reference, ...override } as TopikResourceReference),
      ).toThrow("Resource reference is not valid");
    }
  });
});

describe("resource reference admission", () => {
  test("admits authored navigation but requires resolution at a browser boundary", () => {
    for (const href of ["ref://wiki-page/intro#setup", "REF://Guide/install?view=full"]) {
      expect(validateTopikHref(href)).toEqual([]);
      expect(validateTopikBrowserHref(href)).toEqual([
        {
          id: "link-reference-unresolved",
          level: "error",
          message: "Resource link target requires a browser URL resolver.",
        },
      ]);
    }
    for (const href of ["/docs/install?view=full#setup", "#setup", "https://example.com/docs"]) {
      expect(validateTopikBrowserHref(href)).toEqual(validateTopikHref(href));
    }
  });

  test("reports safe generic errors for malformed references", () => {
    const href = "ref://user:PRIVATE_VALUE@guide/install?token=PRIVATE_VALUE#setup";
    expect(validateTopikHref(href)).toEqual([
      {
        id: "link-reference-invalid",
        level: "error",
        message: "Resource link target is not a valid reference.",
      },
    ]);
    expect(JSON.stringify(validateTopikHref(href))).not.toContain("PRIVATE_VALUE");
    expect(JSON.stringify(validateTopikBrowserHref(href))).not.toContain("PRIVATE_VALUE");
  });

  test("admits inline links, reference definitions, and cards without interpreting examples", () => {
    const source = [
      "[Install](ref://guide/install#setup)",
      "",
      "[Overview][overview]",
      "",
      "[overview]: ref://wiki-page/overview",
      "",
      '{% card title="Installation" href="ref://guide/install" /%}',
      "",
      "Ordinary prose ref://guide/missing remains text.",
      "",
      "`ref://guide/missing`",
      "",
      "```markdown",
      "[Example](ref://guide/missing)",
      "```",
    ].join("\n");
    expect(validateTopikContent(source).valid).toBe(true);
    expect(analyzeTopikContent(source).links.map(({ href, kind }) => ({ href, kind }))).toEqual([
      { href: "ref://guide/install#setup", kind: "link" },
      { href: "ref://wiki-page/overview", kind: "link" },
      { href: "ref://guide/install", kind: "card" },
    ]);
  });

  test("keeps resource references outside image and figure asset slots", () => {
    for (const source of [
      "![Image](ref://guide/install)",
      '{% figure src="ref://guide/install" alt="Example" /%}',
    ]) {
      expect(validateTopikContent(source).valid).toBe(false);
    }
  });
});

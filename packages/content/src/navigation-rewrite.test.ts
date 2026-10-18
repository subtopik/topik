import { afterEach, expect, test, vi } from "vite-plus/test";
import { rewriteTopikNavigationReferences } from "./navigation-rewrite";
import { analyzeTopikContent } from "./links";
import * as parser from "./parser";
import type { TopikContentConfig } from "./config";
import { ContentLimitError } from "./limits";

afterEach(() => vi.restoreAllMocks());

test("navigation rewrite preserves reference definitions and links in all authored branches", () => {
  const source =
    '[First][target]\n\n[target]: next.md?x=a%20b#heading\n\n{% if $show %}\n{% card title="Next" href="next.md?x=a%20b#heading" /%}\n{% else /%}\n[Other](https://example.com/?a=1&a=2)\n{% /if %}\n';
  const result = rewriteTopikNavigationReferences(source, ({ href }) =>
    href.startsWith("next.md") ? "/next-route?x=a%20b#heading" : undefined,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(analyzeTopikContent(result.content).links.map((link) => link.href)).toEqual([
    "/next-route?x=a%20b#heading",
    "/next-route?x=a%20b#heading",
    "https://example.com/?a=1&a=2",
  ]);
  expect(result.changes).toHaveLength(2);
});

test("a definition shared with an image blocks a navigation-only rewrite and retains exact input", () => {
  const source = "[Download][shared]\n\n![Image][shared]\n\n[shared]: image.png\n";
  const result = rewriteTopikNavigationReferences(source, () => "other.png");
  expect(result).toMatchObject({ ok: false, source });
});

test("admits changed navigation with one input parse and one output parse", () => {
  const parse = vi.spyOn(parser, "parseDocumentTree");
  const source = '[Next](next.md)\n\n{% card title="Next" href="next.md" /%}\n';
  const replace = vi.fn(() => "/next");
  const result = rewriteTopikNavigationReferences(source, replace);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected rewritten navigation");
  expect(parse).toHaveBeenCalledTimes(2);
  expect(parse.mock.calls.map(([input]) => input)).toEqual([source, result.content]);
  expect(replace).toHaveBeenCalledTimes(2);
  expect(result.changes.map(({ replacement }) => replacement)).toEqual(["/next", "/next"]);
  expect(result.diagnostics).toEqual([]);
});

test("unchanged navigation retains exact source without output admission", () => {
  const parse = vi.spyOn(parser, "parseDocumentTree");
  const source = "  [Next](next.md)\r\n\r\n";
  const replace = vi.fn(() => undefined);
  expect(rewriteTopikNavigationReferences(source, replace)).toEqual({
    ok: true,
    content: source,
    changes: [],
    diagnostics: [],
  });
  expect(parse).toHaveBeenCalledOnce();
  expect(replace).toHaveBeenCalledOnce();
});

test.each(["javascript:alert(1)", "https://user:secret@example.com/page", ""])(
  "invalid replacement %j retains the source and normalized write failure",
  (replacement) => {
    const source = "[First](first.md) [Second](second.md)\r\n";
    const result = rewriteTopikNavigationReferences(
      source,
      ({ href }) => (href === "first.md" ? "/first" : replacement),
      { file: "guide.md" },
    );
    expect(result).toEqual({
      ok: false,
      source,
      diagnostics: [
        {
          id: "topik-write-failed",
          type: "document",
          level: "error",
          message: "Content could not be written without changing its meaning.",
          lines: [],
          file: "guide.md",
        },
      ],
    });
  },
);

test("conflicting replacements for a shared definition fail before serialization", () => {
  const source = "[First][target] [Second][target]\n\n[target]: next.md\n";
  const replace = vi.fn().mockReturnValueOnce("/first").mockReturnValueOnce("/second");
  const result = rewriteTopikNavigationReferences(source, replace);
  expect(result).toMatchObject({
    ok: false,
    source,
    diagnostics: [{ id: "topik-write-failed" }],
  });
  expect(result).not.toHaveProperty("content");
  expect(replace).toHaveBeenCalledTimes(2);
});

test("retains branch-local reference bindings without merging same-named definitions", () => {
  const source = [
    "[Outer][target]\n\n[target]: root.md",
    "{% if $show %}\n[First][target]\n\n[target]: first.md",
    "{% else /%}\n[Second][target]\n\n[target]: second.md\n{% /if %}",
  ].join("\n\n");
  const replace = vi.fn(({ href }: { href: string }) => `/${href.slice(0, -3)}`);
  const result = rewriteTopikNavigationReferences(source, replace);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected rewritten references");
  expect(replace.mock.calls.map(([reference]) => reference.href)).toEqual([
    "root.md",
    "first.md",
    "second.md",
  ]);
  expect(analyzeTopikContent(result.content).links.map(({ href }) => href)).toEqual([
    "/root",
    "/first",
    "/second",
  ]);
});

test.each([undefined, "/next"])(
  "rejects oversized derived heading metadata before replacement returning %j",
  (replacement) => {
    const source = `# ${"a".repeat(500_100)}\n\n[Next](next.md)\n`;
    const replace = vi.fn(() => replacement);
    expect(() => rewriteTopikNavigationReferences(source, replace)).toThrow(ContentLimitError);
    expect(replace).not.toHaveBeenCalled();
  },
);

test("retains the meaning check when serialization changes Markdown interpretation", () => {
  const source = "***_a_****_a_***\n\n[Next](next.md)\n";
  expect(rewriteTopikNavigationReferences(source, () => "/next")).toMatchObject({
    ok: false,
    source,
    diagnostics: [{ id: "topik-write-failed" }],
  });
});

test("keeps input diagnostics and does not invoke replacement for rejected source", () => {
  const source = "[Unsafe](javascript:alert(1))";
  const replace = vi.fn(() => "/safe");
  expect(rewriteTopikNavigationReferences(source, replace, { file: "guide.md" })).toMatchObject({
    ok: false,
    source,
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ id: "link-scheme-unsafe", file: "guide.md" }),
    ]),
  });
  expect(replace).not.toHaveBeenCalled();
});

test("replacement callback errors remain caller errors", () => {
  const error = new Error("Caller failure");
  expect(() =>
    rewriteTopikNavigationReferences("[Next](next.md)", () => {
      throw error;
    }),
  ).toThrow(error);
});

test("retains the admitted schema when a replacement callback changes caller configuration", () => {
  const config: TopikContentConfig = {
    components: { panel: { kind: "block", render: "Panel", attributes: {}, children: "blocks" } },
  };
  const result = rewriteTopikNavigationReferences(
    "{% panel %}\n[Next](next.md)\n{% /panel %}",
    () => {
      delete config.components!.panel;
      return "/next";
    },
    { config },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected rewritten custom component");
  expect(result.content).toContain("{% panel %}");
  expect(result.content).toContain("[Next](/next)");
});

import { expect, test } from "vite-plus/test";
import { rewriteTopikNavigationReferences } from "./navigation-rewrite";
import { analyzeTopikContent } from "./links";

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

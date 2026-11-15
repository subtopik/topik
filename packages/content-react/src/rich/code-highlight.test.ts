// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import type { TokensResult } from "shiki/core";
import { highlightCode } from "./code-highlight";

const samples: [lang: string, code: string][] = [
  ["ts", "const answer: number = 42;\nexport type Pair<T> = [T, T];"],
  ["js", "import x from 'y';\nconsole.log(`value ${x}`);"],
  ["python", "def greet(name: str) -> str:\n    return f'Hello {name}'"],
  ["html", '<div class="a"><script>let a = 1;</script><style>p { color: red }</style></div>'],
  ["markdown", "# Title\n\n```js\nconst fenced = true;\n```\n\n- *item*"],
  ["vue", '<template><p>{{ msg }}</p></template>\n<script setup lang="ts">const msg = 1</script>'],
  ["rust", 'fn main() {\n    println!("{}", 1 + 2);\n}'],
  ["css", ".a > b:hover { color: #fff; margin: 0 auto; }"],
  ["sh", 'if [ -n "$HOME" ]; then echo "$HOME"; fi'],
  ["json", '{ "key": [1, true, null] }'],
];
const themes = ["github-light", "github-dark"] as const;

describe("rich code highlighting", () => {
  it.each(samples)("matches Shiki's full bundle for %s in both themes", async (lang, code) => {
    const shiki = await import("shiki");
    for (const theme of themes) {
      const expected = await shiki.codeToTokens(code, { lang, theme });
      await expect(highlightCode(code, { lang, theme, engine: "oniguruma" })).resolves.toEqual(
        expected,
      );
    }
  });

  it.each(samples)("tokenizes %s identically with the JavaScript engine", async (lang, code) => {
    // Rendered output only: internal grammar rule ids depend on each highlighter's load order.
    const rendered = ({ tokens, fg, bg, themeName, rootStyle }: TokensResult) => ({
      tokens,
      fg,
      bg,
      themeName,
      rootStyle,
    });
    for (const theme of themes) {
      const expected = await highlightCode(code, { lang, theme, engine: "oniguruma" });
      const actual = await highlightCode(code, { lang, theme, engine: "javascript" });
      expect(rendered(actual)).toEqual(rendered(expected));
    }
  });

  it("rejects unknown languages and themes outside the configured pair", async () => {
    await expect(
      highlightCode("x", { lang: "not-a-language", theme: "github-light", engine: "oniguruma" }),
    ).rejects.toThrow();
    await expect(
      highlightCode("x", {
        lang: "ts",
        theme: "nord" as (typeof themes)[number],
        engine: "javascript",
      }),
    ).rejects.toThrow();
  });
});

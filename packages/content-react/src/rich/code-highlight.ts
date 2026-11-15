import type { ShorthandsBundle, TokensResult } from "shiki/core";
import type { BundledLanguage } from "shiki/langs";
// Public declarations must not reference the optional peer, so the engine type lives there.
import type { RichTopikCodeHighlightEngine } from "./components";

/** The only Shiki themes rich code uses; bundlers emit no others. */
export type RichTopikShikiTheme = "github-light" | "github-dark";

const highlighters = new Map<
  RichTopikCodeHighlightEngine,
  Promise<ShorthandsBundle<BundledLanguage, RichTopikShikiTheme>>
>();

function loadHighlighter(engine: RichTopikCodeHighlightEngine) {
  let highlighter = highlighters.get(engine);
  if (highlighter === undefined) {
    // Every import is lazy: without the optional peer the rich block stays plain code.
    highlighter = Promise.all([import("shiki/core"), import("shiki/langs")]).then(
      ([{ createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages }, langs]) =>
        createSingletonShorthands(
          createBundledHighlighter({
            // Every bundled language stays available; each loads only when first used.
            langs: langs.bundledLanguages,
            themes: {
              "github-light": () => import("shiki/themes/github-light.mjs"),
              "github-dark": () => import("shiki/themes/github-dark.mjs"),
            },
            // Each engine has its own import, so the JavaScript path never reaches WebAssembly.
            engine:
              engine === "javascript"
                ? async () =>
                    (await import("shiki/engine/javascript")).createJavaScriptRegexEngine()
                : async () =>
                    (await import("shiki/engine/oniguruma")).createOnigurumaEngine(
                      import("shiki/wasm"),
                    ),
          }),
          { guessEmbeddedLanguages },
        ),
    );
    // A failed load (for example a missing peer) may be retried by a later block.
    highlighter.catch(() => {
      if (highlighters.get(engine) === highlighter) highlighters.delete(engine);
    });
    highlighters.set(engine, highlighter);
  }
  return highlighter;
}

/** @internal Tokenize code with the rich renderer's Shiki configuration. */
export async function highlightCode(
  code: string,
  options: { lang: string; theme: RichTopikShikiTheme; engine: RichTopikCodeHighlightEngine },
): Promise<TokensResult> {
  const highlighter = await loadHighlighter(options.engine);
  // Authored languages are arbitrary strings; Shiki rejects one it does not bundle.
  return highlighter.codeToTokens(code, {
    lang: options.lang as BundledLanguage,
    theme: options.theme,
  });
}

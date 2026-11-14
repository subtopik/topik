type KatexOptions = NonNullable<Parameters<typeof import("katex").renderToString>[1]>;

/**
 * Largest user-specified dimension (`\rule`, `\kern`, `\hspace`, ...) in ems.
 * Ordinary page math stays far below this (struts and spacing are a few ems),
 * while one command can no longer cover the page or force huge layout boxes.
 * Diagram labels use a smaller limit because they are measured inside shapes.
 */
export const PAGE_MATH_MAX_SIZE = 20;

/** Macro expansion budget; KaTeX's default, stated so it cannot drift. */
export const PAGE_MATH_MAX_EXPAND = 1000;

/** Hardened KaTeX options for authored page math rendered as trusted markup. */
export function pageMathOptions(displayMode: boolean): KatexOptions {
  return {
    displayMode,
    throwOnError: false,
    // Never honour \href, \url, \includegraphics, \htmlClass and similar commands.
    trust: false,
    maxSize: PAGE_MATH_MAX_SIZE,
    maxExpand: PAGE_MATH_MAX_EXPAND,
    // A fresh table per render keeps \gdef from leaking between expressions.
    macros: {},
  };
}

import { renderToString } from "katex";
import { describe, expect, it, vi } from "vite-plus/test";
import { PAGE_MATH_MAX_SIZE, pageMathOptions } from "./page-math";

// The MathML annotation echoes the escaped TeX source; assert on rendered markup only.
const render = (tex: string, displayMode = true) =>
  renderToString(tex, pageMathOptions(displayMode)).replace(
    /<annotation encoding="application\/x-tex">[^<]*<\/annotation>/,
    "",
  );

describe("page math options", () => {
  it("clamps oversized user dimensions", () => {
    const html = render(String.raw`\rule{5000em}{5000em}\kern{9000em}x`);
    expect(html).not.toMatch(/[59]000em/);
    expect(html).toContain(`${PAGE_MATH_MAX_SIZE}em`);
  });

  it("does not trust link, image, or HTML extension commands", () => {
    // KaTeX reports the refused HTML extension under strict: "warn".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const tex of [
      String.raw`\href{javascript:alert(1)}{x}`,
      String.raw`\url{https://example.com}`,
      String.raw`\includegraphics[height=1em]{https://example.com/a.png}`,
      String.raw`\htmlClass{x}{y}`,
      String.raw`\htmlStyle{position:fixed}{y}`,
      String.raw`\htmlData{x=1}{y}`,
      String.raw`\htmlId{x}{y}`,
    ]) {
      const html = render(tex, false);
      expect(html, tex).not.toMatch(/<a\b|<img\b|javascript:|example\.com|position:fixed|data-x/);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTML extension is disabled"));
    warn.mockRestore();
  });

  it("isolates macro definitions between renders", () => {
    expect(pageMathOptions(true).macros).not.toBe(pageMathOptions(true).macros);
    render(String.raw`\gdef\leak{LEAKED}\leak`);
    expect(render(String.raw`\leak`)).not.toContain("LEAKED");
  });

  it("keeps ordinary math intact", () => {
    const html = render(String.raw`\frac{a}{b} + \sqrt{x^2} \quad \rule{0pt}{2em} \hspace{3em} y`);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("2em");
    expect(html).not.toContain("katex-error");
  });
});

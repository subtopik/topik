import type { MathResolver } from "pele";
import { maximumMathDimension, parseDiagramMath } from "./diagram-mathml";

// These budgets apply to each diagram, including formulas Pele resolves at
// different font sizes. Returning null keeps that expression as escaped TeX.
const maximumExpressions = 100;
const maximumExpressionLength = 4096;
const maximumExpressionOutput = 100_000;
const maximumMathOutput = 1_000_000;

async function settleFonts(): Promise<void> {
  if (!document.fonts) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      document.fonts.ready,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function withDiagramMath<T>(
  source: string,
  draw: (math?: MathResolver) => T,
): Promise<T> {
  if (!source.includes("$$") || source.length > 50_000) return draw();
  let katex: typeof import("katex");
  try {
    katex = await import("katex");
    // MathML uses the browser's math font, without KaTeX's HTML/CSS fonts.
    // Let any pending page fonts settle before taking layout measurements.
    await settleFonts();
  } catch {
    return draw();
  }
  const probe = document.createElement("div");
  probe.className = "topik-rich-mermaid";
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;left:-100000px;top:0;visibility:hidden;display:inline-block;width:max-content;white-space:nowrap;margin:0;padding:0;border:0;font-family:math;line-height:normal";
  document.body.append(probe);
  let count = 0;
  let outputLength = 0;
  const math: MathResolver = (tex, size) => {
    if (
      ++count > maximumExpressions ||
      tex.length > maximumExpressionLength ||
      !Number.isFinite(size) ||
      size <= 0 ||
      size > 256 ||
      outputLength >= maximumMathOutput
    )
      return null;
    try {
      const markup = katex.renderToString(tex, {
        displayMode: true,
        output: "mathml",
        throwOnError: true,
        trust: false,
        strict: "error",
        maxExpand: 1000,
        maxSize: 10,
        // Never share definitions (including \gdef) with another expression.
        macros: {},
      });
      outputLength += markup.length;
      if (markup.length > maximumExpressionOutput || outputLength > maximumMathOutput) return null;
      const expression = parseDiagramMath(markup);
      probe.style.fontSize = `${size}px`;
      probe.replaceChildren(document.importNode(expression, true));
      const { width, height } = probe.firstElementChild!.getBoundingClientRect();
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0 ||
        width > maximumMathDimension ||
        height > maximumMathDimension
      )
        return null;
      return { html: expression.outerHTML, width, height };
    } catch {
      return null;
    } finally {
      probe.replaceChildren();
    }
  };
  try {
    return draw(math);
  } finally {
    probe.remove();
  }
}

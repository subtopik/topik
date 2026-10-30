// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";
import { render } from "pele";
import { renderToString } from "katex";
import { safeDiagramSvg } from "./diagram-svg";

const diagrams = [
  "flowchart LR\n A[Start] --> B[End]",
  "sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Hi",
  "classDiagram\n Animal <|-- Duck",
  "stateDiagram-v2\n [*] --> Ready\n Ready --> [*]",
  "erDiagram\n CUSTOMER ||--o{ ORDER : places",
  'pie title Pets\n "Dogs" : 20\n "Cats" : 30',
  "gantt\n title Plan\n dateFormat YYYY-MM-DD\n section Work\n Task :2026-01-01, 2d",
  "journey\n title Day\n section Work\n Write: 5: Me",
  "gitGraph\n commit\n branch feature\n checkout feature\n commit",
  "mindmap\n root((Topic))\n  One\n  Two",
  "timeline\n title History\n 2024 : Start\n 2026 : Now",
  "flowchart LR\n accTitle: My title\n accDescr: My description\n A --> B",
];

describe("Pele SVG boundary", () => {
  const mathContainer = (body: string) => `<foreignObject class="pele-math" x="0" y="0" width="80" height="60" overflow="visible" color="var(--_fg)"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:16px;line-height:normal;white-space:nowrap">${body}</div></foreignObject>`;
  const mathSvg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${mathContainer(body)}</svg>`;

  it.each([
    String.raw`\frac{x_1^2}{\sqrt{y}}`,
    String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`\left|\int_0^1 x\,dx\right|`,
  ])("preserves real KaTeX MathML: %s", (tex) => {
    const output = renderToString(tex, { output: "mathml", displayMode: true, trust: false });
    const math = new DOMParser().parseFromString(output, "application/xml").querySelector("math")!;
    expect(safeDiagramSvg(mathSvg(math.outerHTML))).toContain("<math");
  });

  it.each([
    '<mtext href="https://example.com">x</mtext>',
    '<mglyph src="https://example.com"/>',
    '<annotation-xml encoding="text/html"><div xmlns="http://www.w3.org/1999/xhtml">x</div></annotation-xml>',
    '<mtext onclick="alert(1)">x</mtext>',
    '<mstyle style="background:url(https://example.com)"><mi>x</mi></mstyle>',
    '<mtext xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></mtext>',
    '<mtext><?x ><img src="x" onerror="window.pwned=1">?></mtext>',
    '<mtext><![CDATA[<img src="x" onerror="window.pwned=1">]]></mtext>',
  ])("rejects unsafe MathML: %s", (body) => {
    expect(() => safeDiagramSvg(mathSvg(`<math xmlns="http://www.w3.org/1998/Math/MathML">${body}</math>`))).toThrow();
  });

  it("requires the exact Pele MathML bridge and bounded geometry", () => {
    const valid = mathSvg('<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>');
    for (const unsafe of [
      valid.replace('class="pele-math"', 'class="html-label"'),
      valid.replace('width="80"', 'width="999999"'),
      valid.replace('font-size:16px', 'font-size:999999px'),
      valid.replace('width:100%', 'width:100%;background:url(https://example.com)'),
      valid.replace('</math>', '</math><a href="https://example.com">link</a>'),
      valid.replace('color="var(--_fg)"', 'color="url(https://example.com)"'),
    ]) expect(() => safeDiagramSvg(unsafe)).toThrow();
    expect(() => safeDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></svg>')).toThrow();
  });

  it.each(diagrams)("renders %s", (source) => {
    const result = render(source, { links: false, images: false, idPrefix: "diagram-1" });
    expect(safeDiagramSvg(result.svg)).toContain("<svg");
  });
  it("preserves accessible labels with per-diagram IDs", () => {
    const source = diagrams.at(-1)!;
    for (const idPrefix of ["one", "two"]) {
      const svg = safeDiagramSvg(render(source, { idPrefix }).svg);
      expect(svg).toContain(`aria-labelledby="${idPrefix}-title"`);
      expect(svg).toContain(`aria-describedby="${idPrefix}-desc"`);
      expect(svg).toContain("My description");
    }
  });
  it.each([
    "<script>alert(1)</script>",
    '<image href="https://example.com/x"/>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
    '<text onclick="alert(1)">x</text>',
    '<use href="https://example.com/x#y"/>',
    '<path style="fill:url(https://example.com/x)"/>',
    '<path style="fill:u\\72l(https://example.com/x)"/>',
    '<animate attributeName="href" values="javascript:alert(1)"/>',
    '<?x ><img src="x" onerror="window.pwned=1">?>',
  ])("rejects active SVG: %s", (body) => {
    expect(() => safeDiagramSvg(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`)).toThrow();
  });
  it("disables authored links, images and config attempts to enable them", () => {
    const source =
      '%%{init: {"links":true,"images":true,"securityLevel":"loose"}}%%\nflowchart LR\n A[Safe] --> B[End]\n click A "https://example.com"';
    const svg = safeDiagramSvg(render(source, { links: false, images: false }).svg);
    expect(svg).not.toMatch(/<a\b|href=|<image\b|onclick=/);
  });
  it("rejects malformed source", () => {
    expect(() => render("not a diagram")).toThrow();
  });
});


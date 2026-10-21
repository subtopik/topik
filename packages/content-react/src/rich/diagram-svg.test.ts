// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";
import { render } from "pele";
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

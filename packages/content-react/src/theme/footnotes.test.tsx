// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { getTopikComponents } from "../core/components";
import { renderTopikMarkdown } from "../core/render";
import { TopikContent } from "./TopikContent";
import { TopikFootnote, TopikFootnoteReference, TopikFootnotes } from "./components";

const source = [
  "Topik validates content[^v] before it compiles it.[^c]",
  "",
  "More text, again[^v].",
  "",
  "[^c]: Compilation also resolves assets.",
  "",
  "[^v]: Validation checks every branch.",
].join("\n");

function dom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("themed footnotes", () => {
  test("references link to their notes and notes link back", () => {
    const page = dom(renderToStaticMarkup(<TopikContent content={source} />));
    const references = [...page.querySelectorAll(".topik-footnote-ref a")];
    expect(
      references.map((link) => [link.id, link.getAttribute("href"), link.textContent]),
    ).toEqual([
      ["fnref:1", "#fn:1", "1"],
      ["fnref:2", "#fn:2", "2"],
      ["fnref:1:2", "#fn:1", "1"],
    ]);
    expect(references[0].getAttribute("aria-label")).toBe("Footnote 1");

    const section = page.querySelector("section.topik-footnotes")!;
    expect(section.getAttribute("aria-label")).toBe("Footnotes");
    // The list comes last in the article, after all content.
    expect(page.querySelector("article")!.lastElementChild).toBe(section);
    const notes = [...section.querySelectorAll("li.topik-footnote")];
    expect(notes.map((note) => note.id)).toEqual(["fn:1", "fn:2"]);
    expect(notes[0].textContent).toContain("Validation checks every branch.");
    expect(
      [...notes[0].querySelectorAll(".topik-footnote__backrefs a")].map((link) => [
        link.getAttribute("href"),
        link.getAttribute("aria-label"),
      ]),
    ).toEqual([
      ["#fnref:1", "Back to reference 1 (1)"],
      ["#fnref:1:2", "Back to reference 1 (2)"],
    ]);
    expect(notes[1].querySelector(".topik-footnote__backrefs a")?.getAttribute("aria-label")).toBe(
      "Back to reference 2",
    );
  });

  test("a page without footnotes renders no list", () => {
    expect(renderToStaticMarkup(<TopikContent content="Plain text." />)).not.toContain(
      "topik-footnotes",
    );
  });

  test("components ignore anchors that the tree does not generate", () => {
    const html = renderToStaticMarkup(
      <>
        <TopikFootnoteReference id="javascript:x" number={1} target="https://evil.test" />
        <TopikFootnotes>
          <TopikFootnote backrefs={["fnref:1", "javascript:x"]} id="x" number={1}>
            Note.
          </TopikFootnote>
        </TopikFootnotes>
      </>,
    );
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("evil.test");
    expect(html).toContain('href="#fnref:1"');
    expect(renderToStaticMarkup(<TopikFootnoteReference number={0} />)).toBe("");
  });
});

describe("plain footnotes", () => {
  test("without themed components, footnotes stay linked", () => {
    const page = dom(renderToStaticMarkup(<>{renderTopikMarkdown(source)}</>));
    expect([...page.querySelectorAll("sup > a")].map((link) => link.getAttribute("href"))).toEqual([
      "#fn:1",
      "#fn:2",
      "#fn:1",
    ]);
    const items = [...page.querySelectorAll("section[aria-label=Footnotes] > ol > li")];
    expect(items.map((item) => item.id)).toEqual(["fn:1", "fn:2"]);
    expect(items[0].querySelectorAll("a[href^='#fnref']")).toHaveLength(2);
  });

  test("the plain components are the core fallbacks", () => {
    const components = getTopikComponents();
    expect(
      renderToStaticMarkup(
        <components.TopikFootnoteReference number={3} id="fnref:3" target="fn:3" />,
      ),
    ).toBe('<sup><a aria-label="Footnote 3" href="#fn:3" id="fnref:3">3</a></sup>');
  });
});

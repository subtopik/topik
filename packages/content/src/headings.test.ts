import { parseTopikContent } from "./content.js";
import { describe, expect, test } from "vite-plus/test";
import { assignTopikHeadingIds } from "./test-helpers";
import {
  analyzeTopikContent,
  isContentTag,
  transformTopikContent,
  validateTopikContent,
} from "./index.js";

describe("assignTopikHeadingIds", () => {
  test("generates GitHub-compatible IDs from formatted heading text", () => {
    const ast = parseTopikContent("## This'll be a **Helpful** `Topik` Section!");

    expect(assignTopikHeadingIds(ast)).toEqual([
      {
        id: "thisll-be-a-helpful-topik-section",
        level: 2,
        title: "This'll be a Helpful Topik Section!",
      },
    ]);
  });

  test("suffixes duplicate generated IDs within a document", () => {
    const ast = parseTopikContent("## Setup\n\n## Setup\n\n## Setup");

    expect(assignTopikHeadingIds(ast).map((heading) => heading.id)).toEqual([
      "setup",
      "setup-1",
      "setup-2",
    ]);
  });

  test("marks generated IDs whose titles other headings share as positional", () => {
    const ast = parseTopikContent(
      "## Setup\n\n## Setup {% #own %}\n\n## C++\n\n## C#\n\n## Setup\n\n## Unique",
    );

    expect(
      assignTopikHeadingIds(ast).map(({ id, positional }) => (positional ? `${id}*` : id)),
    ).toEqual(["setup*", "own", "c*", "c-1*", "setup-1*", "unique"]);
  });

  test.each([
    ["## Step 1\n\n## Step\n\n## Step", ["step-1*", "step*", "step-2*"]],
    ["## Setup\n\n## Setup\n\n## Setup 1", ["setup*", "setup-1*", "setup-1-1*"]],
    ["## A\n\n## A\n\n## A 1\n\n## A 1 1", ["a*", "a-1*", "a-1-1*", "a-1-1-1*"]],
    ["## Step\n\n## Step 1", ["step", "step-1"]],
  ])("marks a numbered title that a repeated title's numbering can reach: %j", (source, ids) => {
    expect(
      assignTopikHeadingIds(parseTopikContent(source)).map(({ id, positional }) =>
        positional ? `${id}*` : id,
      ),
    ).toEqual(ids);
  });

  test("an explicit ID does not make the generated ID that skips it positional", () => {
    const ast = parseTopikContent("## Setup {% #setup %}\n\n## Setup");

    expect(assignTopikHeadingIds(ast)).toEqual([
      { id: "setup", level: 2, title: "Setup" },
      { id: "setup-1", level: 2, title: "Setup" },
    ]);
  });

  test("gives headings without sluggable text a deduplicated fallback ID", () => {
    const source =
      "#\n\n# \n\n# ![](https://e.com/a.png)\n\n## !!!\n\n## Section\n\n## Taken {% #section-5 %}";
    const expected = ["section", "section-1", "section-2", "section-3", "section-4", "section-5"];
    expect(analyzeTopikContent(source).headings.map(({ id }) => id)).toEqual(expected);
    const tree = transformTopikContent(parseTopikContent(source));
    if (!isContentTag(tree)) throw new Error("Expected article");
    expect(tree.children.filter(isContentTag).map((node) => node.attributes.id)).toEqual(expected);
  });

  test("preserves and reserves explicit authored IDs", () => {
    const ast = parseTopikContent("## Introduction {% #start-here %}\n\n## Start Here");

    expect(assignTopikHeadingIds(ast).map((heading) => heading.id)).toEqual([
      "start-here",
      "start-here-1",
    ]);
  });

  test.each([
    ["API", "API", "api"],
    ["a:b", "ab", "ab"],
    ["a.b", "ab", "ab"],
  ])("reserves the exact explicit ID %s without slugifying it", (explicit, title, generated) => {
    const source = `## Explicit {% #${explicit} %}\n\n## ${title}\n\n[Jump](#${generated})`;
    expect(analyzeTopikContent(source).headings.map(({ id }) => id)).toEqual([explicit, generated]);
    expect(transformTopikContent(parseTopikContent(source))).toMatchObject({
      children: [
        { attributes: { id: explicit } },
        { attributes: { id: generated } },
        { children: [{ attributes: { href: `#${generated}` } }] },
      ],
    });
  });

  test("skips explicit suffixes and generated IDs regardless of heading order", () => {
    const ast = parseTopikContent(
      "## Setup\n\n## Setup\n\n## Setup-1\n\n## Reserved {% #setup %}\n\n## Reserved {% #setup-1 %}",
    );
    const expected = ["setup-2", "setup-3", "setup-1-1", "setup", "setup-1"];
    expect(assignTopikHeadingIds(ast).map(({ id }) => id)).toEqual(expected);
    expect(assignTopikHeadingIds(ast).map(({ id }) => id)).toEqual(expected);
  });

  test.each([true, false])("keeps analyzed anchors when a branch is selected: %s", (show) => {
    const source = [
      "{% if $show %}",
      "## Setup",
      "{% else /%}",
      "## Setup",
      "{% /if %}",
      "",
      "## Setup",
      "",
      "[Continue](#setup-2)",
    ].join("\n");
    const document = parseTopikContent(source);
    const original = structuredClone(document);
    const analysis = analyzeTopikContent(source);
    expect(analysis.headings.map(({ id }) => id)).toEqual(["setup", "setup-1", "setup-2"]);
    const tree = transformTopikContent(document, { variables: { show } });
    if (!isContentTag(tree)) throw new Error("Expected article");
    expect(tree.children.filter(isContentTag).map((node) => node.attributes.id)).toEqual([
      show ? "setup" : "setup-1",
      "setup-2",
      undefined,
    ]);
    expect(document).toEqual(original);
  });

  test("reserves explicit IDs and nested hidden headings before rendering", () => {
    const source = [
      "{% if false %}",
      "{% if $missing %}",
      "## Hidden {% #setup %}",
      "{% /if %}",
      "{% /if %}",
      "",
      "## Setup",
    ].join("\n");
    expect(transformTopikContent(parseTopikContent(source))).toMatchObject({
      children: [{ name: "h2", attributes: { id: "setup-1" } }],
    });
  });

  test("interpolated heading text does not change its authored anchor", () => {
    const source = "## Hello {% $name %}\n\n[Go](#hello)";
    expect(analyzeTopikContent(source).headings[0].id).toBe("hello");
    expect(
      transformTopikContent(parseTopikContent(source), { variables: { name: "Ada" } }),
    ).toMatchObject({
      children: [{ name: "h2", attributes: { id: "hello" }, children: ["Hello Ada"] }, {}],
    });
  });
});

describe("accordion IDs", () => {
  const anchors = (source: string) =>
    analyzeTopikContent(source).anchors.map(({ id, kind, positional }) =>
      [kind, positional ? `${id}*` : id].join(":"),
    );

  test("share one set of IDs with headings, in document order", () => {
    expect(
      anchors(
        [
          '{% accordion title="FAQ" %}\nA\n{% /accordion %}',
          "## FAQ",
          '{% accordion title="Grading" id="grading" %}\nB\n{% /accordion %}',
          "## Grading",
        ].join("\n\n"),
      ),
    ).toEqual(["accordion:faq*", "heading:faq-1*", "accordion:grading", "heading:grading-1"]);
  });

  test("generated IDs ignore interpolated variables, like heading IDs", () => {
    expect(
      anchors(
        [
          '{% accordion title=t"Week {% $week %} notes" %}\nA\n{% /accordion %}',
          '{% accordion title=t"{% $name %}" %}\nB\n{% /accordion %}',
        ].join("\n\n"),
      ),
    ).toEqual(["accordion:week-notes", "accordion:section"]);
  });

  test("accordions are link targets but not headings", () => {
    const result = analyzeTopikContent('{% accordion title="FAQ" %}\nA\n{% /accordion %}');
    expect(result.headings).toEqual([]);
    expect(result.anchors).toEqual([
      expect.objectContaining({ id: "faq", kind: "accordion", lines: [1] }),
    ]);
  });

  test("explicit IDs are unique across headings and accordions", () => {
    const result = analyzeTopikContent(
      '## Grading {% #grading %}\n\n{% accordion title="Grading" id="grading" %}\nA\n{% /accordion %}',
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ id: "heading-id-duplicate", type: "accordion", lines: [3] }),
    ]);
  });

  test("explicit IDs use the heading ID characters", () => {
    const result = validateTopikContent(
      '{% accordion title="Grading" id="two words" %}\nA\n{% /accordion %}',
    );
    expect(result.diagnostics).toEqual([expect.objectContaining({ id: "topik-accordion-id" })]);
  });

  test("the reader tree carries generated and explicit IDs", () => {
    const tree = transformTopikContent(
      parseTopikContent(
        '{% accordion title="FAQ" %}\nA\n{% /accordion %}\n\n{% accordion title="X" id="pinned" %}\nB\n{% /accordion %}',
      ),
    );
    const ids: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (isContentTag(node)) {
        if (node.name === "TopikAccordion") ids.push(node.attributes.id);
        node.children.forEach(walk);
      }
    };
    walk(tree);
    expect(ids).toEqual(["faq", "pinned"]);
  });
});

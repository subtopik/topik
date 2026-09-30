import { parseTopikContent } from "./content.js";
import { describe, expect, test } from "vite-plus/test";
import { assignTopikHeadingIds } from "./headings";
import { analyzeTopikContent, isContentTag, transformTopikContent } from "./index.js";

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

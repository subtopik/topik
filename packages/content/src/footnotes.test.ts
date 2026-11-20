import { describe, expect, test } from "vite-plus/test";
import {
  compileTopikContent,
  evaluateDocument,
  formatTopikContent,
  isContentTag,
  parseDocument,
  rewriteTopikAssetOccurrences,
  sameDocumentMeaning,
  validateDocument,
  validateTopikContent,
  writeDocument,
  type ContentDocument,
  type RenderableTreeNode,
} from "./index.js";
import { parse } from "./test-helpers.js";

function ids(source: string): (string | undefined)[] {
  return validateTopikContent(source).errors.map((error) => error.id);
}

function formatted(source: string): string {
  const result = formatTopikContent(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.formatted;
}

function tags(node: RenderableTreeNode, name: string): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((child) => tags(child, name));
  if (!isContentTag(node)) return [];
  return [
    ...(node.name === name ? [node.attributes] : []),
    ...node.children.flatMap((child) => tags(child, name)),
  ];
}

const authored = [
  "Topik validates content[^v] before it compiles it.[^c]",
  "",
  "[^c]: Compilation also resolves **assets**.",
  "",
  "    A second paragraph.",
  "",
  "More text, again[^v].",
  "",
  "[^v]: Validation checks every branch.",
].join("\n");

describe("footnote source", () => {
  test("definitions are accepted anywhere at the top level", () => {
    expect(validateTopikContent(authored)).toMatchObject({ valid: true });
  });

  test.each([
    ["inside a quote", "Note[^a]\n\n> [^a]: Value", "topik-footnote-placement"],
    ["inside a list", "- Note[^a]\n\n  [^a]: Value", "topik-footnote-placement"],
    [
      "inside a component",
      "Note[^a]\n\n{% callout %}\n[^a]: Value\n{% /callout %}",
      "topik-footnote-placement",
    ],
    [
      "inside a conditional branch",
      "Note[^a]\n\n{% if $x %}\n[^a]: Value\n{% /if %}",
      "topik-footnote-placement",
    ],
    [
      "a reference inside a link",
      "[Link[^a]](https://x.test)\n\n[^a]: V",
      "topik-footnote-placement",
    ],
    [
      "a reference inside a definition",
      "Note[^a]\n\n[^a]: V[^b]\n\n[^b]: W",
      "topik-footnote-nested",
    ],
    [
      "a label defined twice",
      "Note[^a] and [^A]\n\n[^a]: V\n\n[^A]: W",
      "topik-footnote-duplicate",
    ],
    ["an unreferenced definition", "Text.\n\n[^a]: Note", "topik-footnote-unreferenced"],
    [
      "a heading inside a definition",
      "Note[^a]\n\n[^a]: Value\n\n    ## Title",
      "topik-footnote-content",
    ],
    [
      "a link definition inside a definition",
      "Note[^a] [x][y]\n\n[^a]: Value\n\n    [y]: https://x.test",
      "topik-footnote-content",
    ],
    [
      "a block conditional inside a definition",
      "Note[^a]\n\n[^a]: Value\n\n    {% if $x %}\n    More\n    {% /if %}",
      "topik-footnote-content",
    ],
    [
      "an explicit heading ID like a footnote anchor",
      "## A {% #fn:1 %}",
      "topik-heading-id-reserved",
    ],
    [
      "an explicit heading ID like a reference anchor",
      "## A {% #fnref:1 %}",
      "topik-heading-id-reserved",
    ],
    [
      "an explicit accordion ID like a footnote anchor",
      '{% accordion title="A" id="fn:1" %}\nBody.\n{% /accordion %}',
      "topik-heading-id-reserved",
    ],
  ])("refuses %s", (_name, source, id) => {
    expect(ids(source)).toContain(id);
  });

  test("a reference without a definition is refused in a built tree", () => {
    // Markdown keeps `[^a]` as text without a definition; editors can still build one.
    const document = parse("Note[^a].\n\n[^a]: Value");
    document.children.pop();
    expect(validateDocument(document).map((error) => error.id)).toContain("topik-footnote-missing");
  });

  test("references work in headings, lists, table cells and inline components", () => {
    const source = [
      "## Heading[^a]",
      "",
      "- Item[^a]",
      "",
      "| A | B |",
      "| --- | --- |",
      "| Cell[^a] | {% badge %}Badge[^a]{% /badge %} |",
      "",
      "[^a]: Note.",
    ].join("\n");
    expect(validateTopikContent(source)).toMatchObject({ valid: true });
  });

  test("labels keep their authored spelling and match case-insensitively", () => {
    const output = formatted("Use the RFC[^RFC9110].\n\n[^rfc9110]: HTTP Semantics.");
    expect(output).toBe("Use the RFC[^RFC9110].\n\n[^rfc9110]: HTTP Semantics.\n");
  });
});

describe("canonical footnote position", () => {
  test("formatting writes definitions at the end in order of first reference", () => {
    expect(formatted(authored)).toBe(
      [
        "Topik validates content[^v] before it compiles it.[^c]",
        "",
        "More text, again[^v].",
        "",
        "[^v]: Validation checks every branch.",
        "",
        "[^c]: Compilation also resolves **assets**.",
        "",
        "    A second paragraph.",
        "",
      ].join("\n"),
    );
  });

  test("formatting is stable", () => {
    const once = formatted(authored);
    expect(formatted(once)).toBe(once);
  });

  test("moving a definition does not change the document's meaning", () => {
    const original = parse(authored);
    const moved = parse(formatted(authored));
    expect(sameDocumentMeaning(original, moved)).toBe(true);
    const edited = parse(formatted(authored).replace("every branch", "each branch"));
    expect(sameDocumentMeaning(original, edited)).toBe(false);
  });

  test("references in conditional branches count in document order", () => {
    const source = [
      "{% if $teacher %}",
      "Teacher note[^t].",
      "{% else /%}",
      "Student note[^s].",
      "{% /if %}",
      "",
      "[^s]: For students.",
      "",
      "[^t]: For teachers.",
    ].join("\n");
    expect(formatted(source)).toMatch(/\[\^t\]: For teachers\.\n\n\[\^s\]: For students\.\n$/u);
  });

  test("targeted rewrites keep definitions where they were authored", () => {
    const source = "Logo[^a]\n\n[^a]: ![Logo](old.png)\n\nAfter.";
    const rewritten = rewriteTopikAssetOccurrences(source, () => "new.png");
    expect(rewritten).toMatchObject({ ok: true });
    if (rewritten.ok)
      expect(rewritten.content).toBe("Logo[^a]\n\n[^a]: ![Logo](new.png)\n\nAfter.\n");
  });
});

describe("footnote evaluation and rendering", () => {
  const conditional = [
    "Shown[^a].",
    "",
    "{% if $teacher %}",
    "Teacher note[^t].",
    "{% /if %}",
    "",
    "[^a]: Always.",
    "",
    "[^t]: For teachers.",
  ].join("\n");

  test("evaluation drops a footnote whose references are all hidden", () => {
    const document = parse(conditional);
    const hidden = evaluateDocument(document, { teacher: false });
    expect(writeDocument(hidden)).toBe("Shown[^a].\n\n[^a]: Always.\n");
    const shown = evaluateDocument(document, { teacher: true });
    expect(writeDocument(shown)).toContain("[^t]: For teachers.");
  });

  test("the reader tree numbers footnotes by first reference and lists them at the end", () => {
    const compiled = compileTopikContent(authored);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(tags(compiled.tree, "TopikFootnoteReference")).toEqual([
      { number: 1, id: "fnref:1", target: "fn:1" },
      { number: 2, id: "fnref:2", target: "fn:2" },
      { number: 1, id: "fnref:1:2", target: "fn:1" },
    ]);
    expect(tags(compiled.tree, "TopikFootnote")).toEqual([
      { number: 1, id: "fn:1", backrefs: ["fnref:1", "fnref:1:2"] },
      { number: 2, id: "fn:2", backrefs: ["fnref:2"] },
    ]);
    const article = compiled.tree as { children: RenderableTreeNode[] };
    const last = article.children.at(-1);
    expect(isContentTag(last) && last.name).toBe("TopikFootnotes");
  });

  test("hidden references are not numbered", () => {
    const compiled = compileTopikContent(conditional, {
      config: { variables: { teacher: false } },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(tags(compiled.tree, "TopikFootnote")).toEqual([
      { number: 1, id: "fn:1", backrefs: ["fnref:1"] },
    ]);
  });

  test("a hidden footnote's body is not evaluated", () => {
    // `$name` is absent: only the hidden branch needs it.
    const source = conditional.replace("For teachers.", "For {% $name %}.");
    expect(writeDocument(evaluateDocument(parse(source), { teacher: false }))).toBe(
      "Shown[^a].\n\n[^a]: Always.\n",
    );
    expect(() => evaluateDocument(parse(source), { teacher: true })).toThrow();
  });

  test("a footnote whose body evaluates to nothing is dropped with its references", () => {
    const source = "Shown[^a] and kept[^b].\n\n[^a]: {% $empty %}\n\n[^b]: Kept.";
    expect(writeDocument(evaluateDocument(parse(source), { empty: "" }))).toBe(
      "Shown and kept[^b].\n\n[^b]: Kept.\n",
    );
  });

  test("references the renderer omits are not numbered", () => {
    const config = {
      components: {
        omitted: {
          kind: "block" as const,
          render: false,
          attributes: {},
          children: "blocks" as const,
        },
      },
    };
    const source = [
      "{% omitted %}",
      "Hidden[^h].",
      "{% /omitted %}",
      "",
      "Shown[^s].",
      "",
      "[^h]: Hidden note.",
      "",
      "[^s]: Shown note.",
    ].join("\n");
    const compiled = compileTopikContent(source, { config });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(tags(compiled.tree, "TopikFootnoteReference")).toEqual([
      { number: 1, id: "fnref:1", target: "fn:1" },
    ]);
    expect(tags(compiled.tree, "TopikFootnote")).toEqual([
      { number: 1, id: "fn:1", backrefs: ["fnref:1"] },
    ]);
    expect(JSON.stringify(compiled.tree)).not.toContain("Hidden note.");
  });

  test("a document without footnotes has no footnote list", () => {
    const compiled = compileTopikContent("Plain text.");
    expect(compiled.ok && tags(compiled.tree, "TopikFootnotes")).toEqual([]);
  });

  test("definitions can hold block content and templates", () => {
    const source = "Note[^a].\n\n[^a]: For {% $name %}.\n\n    - A list\n    - in a note";
    const document: ContentDocument = parse(source);
    expect(validateDocument(document)).toEqual([]);
    const compiled = compileTopikContent(source, { config: { variables: { name: "Ada" } } });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(JSON.stringify(compiled.tree)).toContain("For Ada.");
    expect(parseDocument(formatted(source))).toMatchObject({ ok: true });
  });
});

describe("footnotes next to other constructs", () => {
  test("a quiz explanation cannot hold a footnote reference", () => {
    // The explanation appears only after an answer, so its reference would be numbered first.
    const source = [
      "{% quiz %}",
      "{% question %}",
      "{% choice correct=true %}\nA\n{% /choice %}",
      "{% choice %}\nB\n{% /choice %}",
      "{% explanation %}\nSee[^1].\n{% /explanation %}",
      "{% /question %}",
      "{% /quiz %}",
      "",
      "Visible[^2].",
      "",
      "[^1]: one",
      "",
      "[^2]: two",
    ].join("\n");
    expect(ids(source)).toEqual(["topik-footnote-placement"]);
  });

  test.each([
    ["at the start of a paragraph", "[^1]\\: b\n\n[^1]: note\n"],
    ["after a hard break", "a\\\n[^1]\\: b\n\n[^1]: note\n"],
    ["in a list item", "- [^1]\\: b\n\n[^1]: note\n"],
    ["after a hard break in strong text", "**a\\\n[^1]\\: x**\n\n[^1]: note\n"],
    ["after a hard break in emphasis", "_a\\\n[^1]\\: x_\n\n[^1]: note\n"],
    ["after a hard break in strikethrough", "~~a\\\n[^1]\\: x~~\n\n[^1]: note\n"],
    [
      "after a hard break in an inline tag",
      "{% badge %}a\\\n[^1]\\: x{% /badge %}\n\n[^1]: note\n",
    ],
    ["after a line ending in strong text", "**a\n[^1]\\: x**\n\n[^1]: note\n"],
  ])("a colon after a reference that starts a line stays text %s", (_where, source) => {
    expect(formatted(source)).toBe(source);
    expect(formatted("[^1]&#58; b\n\n[^1]: note\n")).toBe("[^1]\\: b\n\n[^1]: note\n");
  });

  test("a colon after a reference inside a line is written as is", () => {
    const source = "See [^1]: details.\n\n[^1]: note\n";
    expect(formatted(source)).toBe(source);
  });

  test("a reference in a table cell cannot carry an unescaped pipe", () => {
    const escaped = "| A |\n| - |\n| x[^a\\|b] |\n\n[^a\\|b]: Note.\n";
    expect(ids(escaped)).toEqual([]);
    expect(formatted(escaped)).toBe(
      "| A        |\n| -------- |\n| x[^a\\|b] |\n\n[^a\\|b]: Note.\n",
    );
    expect(ids("Use[^a|b].\n\n[^a|b]: Note.\n")).toEqual([]);

    // A tree built in code can place a reference with a bare pipe in a cell.
    type Node = { type: string; children?: Node[]; [key: string]: unknown };
    const document: ContentDocument = parse("| A |\n| - |\n| x |\n\nUse[^a|b].\n\n[^a|b]: Note.\n");
    const table = (document as Node).children!.find((child) => child.type === "table")!;
    const cell = table.children![1].children![0];
    cell.children!.push({ type: "footnoteReference", identifier: "a|b", label: "a|b" });
    expect(validateDocument(document).map((error) => error.id)).toEqual(["topik-reference-label"]);
  });

  test("an escaped label keeps its authored spelling", () => {
    const source = "Use[^a\\+b].\n\n[^a\\+b]: Note.\n";
    expect(ids(source)).toEqual([]);
    expect(formatted(source)).toBe(source);
  });
});

import { describe, expect, test } from "vite-plus/test";
import { getEffectiveProps, parseDocument, writeDocument } from "../index.js";
import { parse, withoutPositions } from "../test-helpers.js";

describe("badge source contract", () => {
  test("retains styled inline children and optional variant", () => {
    const source = 'Ready: {% badge variant="success" %}**Stable**{% /badge %}.';
    const document = parse(source);
    expect(document.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text" },
        {
          type: "topikComponent",
          name: "badge",
          props: { variant: "success" },
          children: [{ type: "strong", children: [{ type: "text", value: "Stable" }] }],
        },
        { type: "text" },
      ],
    });
    expect(withoutPositions(parse(writeDocument(document)))).toEqual(withoutPositions(document));
  });

  test("defaults omitted variant without changing authored props", () => {
    const document = parse("{% badge %}New{% /badge %}");
    const paragraph = document.children[0];
    if (paragraph.type !== "paragraph" || paragraph.children[0].type !== "topikComponent")
      throw new Error("Expected badge");
    expect(paragraph.children[0].props).toEqual({});
    expect(getEffectiveProps(paragraph.children[0])).toEqual({ variant: "neutral" });
    expect(writeDocument(document)).toContain("{% badge %}New{% /badge %}");
  });

  test.each([
    ['{% badge variant="invalid" %}Bad{% /badge %}', "attribute-value-invalid"],
    ["{% badge /%}", "topik-badge-children"],
  ])("refuses invalid badge source and retains it", (source, id) => {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics.map((item) => item.id)).toContain(id);
  });
});

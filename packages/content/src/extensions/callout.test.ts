import { describe, expect, test } from "vite-plus/test";
import {
  getEffectiveProps,
  parseDocument,
  writeDocument,
  type Component,
  type ContentDocument,
} from "../index.js";
import { parse } from "../test-helpers.js";

function callout(document: ContentDocument): Component {
  const node = document.children.find(
    (child): child is Component => child.type === "topikComponent" && child.name === "callout",
  );
  if (!node) throw new Error("Expected a callout");
  return node;
}

describe("callout content contract", () => {
  test.each(["info", "tip", "warning", "danger"])(
    "accepts %s with block flow content",
    (variant) => {
      const document = parse(
        `{% callout variant="${variant}" %}\n\nA **note**.\n\n- First\n- Second\n\n{% /callout %}`,
      );
      expect(callout(document)).toMatchObject({
        props: { variant },
        children: [{ type: "paragraph" }, { type: "list" }],
      });
      const written = writeDocument(document);
      expect(callout(parse(written)).props).toEqual({ variant });
      expect(writeDocument(parse(written))).toBe(written);
    },
  );

  test.each(["text", "listItem", "tableCell"])(
    "refuses a direct %s child that cannot be block flow content",
    (type) => {
      const document = {
        type: "root",
        children: [{ type: "topikComponent", name: "callout", props: {}, children: [{ type }] }],
      } as ContentDocument;
      expect(() => writeDocument(document)).toThrow("callout may contain only block children");
    },
  );

  test("preserves absent variant and title while exposing the effective default", () => {
    const document = parse("{% callout %}\n\nText.\n\n{% /callout %}");
    expect(callout(document).props).toEqual({});
    expect(getEffectiveProps(callout(document))).toEqual({ variant: "info" });
    expect(getEffectiveProps(callout(document))).not.toBe(callout(document).props);
    expect(callout(document).props).toEqual({});
    const written = writeDocument(document);
    expect(written).toContain("{% callout %}");
    expect(callout(parse(written)).props).toEqual({});
    expect(writeDocument(parse(written))).toBe(written);
  });

  test("keeps omitted, empty, and nonempty titles distinct", () => {
    for (const [attribute, expected] of [
      ["", {}],
      [' title=""', { title: "" }],
      [' title="Heads up"', { title: "Heads up" }],
    ] as const) {
      const document = parse(`{% callout${attribute} %}\n\nText.\n\n{% /callout %}`);
      expect(callout(document).props).toEqual(expected);
      expect(callout(parse(writeDocument(document))).props).toEqual(expected);
    }
  });

  test("document edits preserve siblings and round-trip through source", () => {
    const source =
      'Before.\n\n{% callout title="" %}\n\nEdit **this** body.\n\n{% /callout %}\n\nAfter.';
    const document = parse(source);
    const editedCallout = callout(document);
    editedCallout.props = { variant: "tip", title: "" };
    const paragraph = editedCallout.children[0];
    if (paragraph.type !== "paragraph") throw new Error("Expected a paragraph");
    const strong = paragraph.children[1];
    if (strong.type !== "strong" || strong.children[0]?.type !== "text")
      throw new Error("Expected styled text");
    strong.children[0].value = "that";

    const saved = writeDocument(document);
    const reopened = parse(saved);
    expect(reopened.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "Before." }],
    });
    expect(reopened.children[2]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "After." }],
    });
    expect(callout(reopened)).toMatchObject({
      props: { variant: "tip", title: "" },
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Edit " },
            { type: "strong", children: [{ type: "text", value: "that" }] },
            { type: "text", value: " body." },
          ],
        },
      ],
    });
    expect(writeDocument(reopened)).toBe(saved);
  });

  test.each(["note", "INFO", "", "success"])(
    "refuses invalid variant %j and retains source",
    (variant) => {
      const source = `{% callout variant="${variant}" %}\n\nText.\n\n{% /callout %}`;
      const result = parseDocument(source);
      expect(result).toMatchObject({ ok: false, source });
      if (!result.ok)
        expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
          "Invalid variant on callout",
        );
    },
  );
});

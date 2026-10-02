import { describe, expect, test } from "vite-plus/test";
import { components, parseDocument, writeDocument, type Registry } from "../index.js";
import { withoutPositions, parse as parsed } from "../test-helpers.js";

// A consumer-defined component exercises extension support outside the catalog.
const registry: Registry = {
  ...components,
  tooltip: {
    kind: "inline",
    attributes: { text: { type: "string", required: true } },
    children: "inline",
    render: "TopikTooltip",
  },
};

describe("tooltip source contract", () => {
  test("paired inline tooltip retains styled children through source writing", () => {
    const source = 'Read {% tooltip text="Help" %}**publishing** settings{% /tooltip %}.';
    const document = parsed(source, registry);
    expect(document.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "Read " },
        {
          type: "topikComponent",
          name: "tooltip",
          props: { text: "Help" },
          children: [
            { type: "strong", children: [{ type: "text", value: "publishing" }] },
            { type: "text", value: " settings" },
          ],
        },
        { type: "text", value: "." },
      ],
    });
    const exported = writeDocument(document, registry);
    expect(withoutPositions(parsed(exported, registry).children)).toEqual(
      withoutPositions(document.children),
    );
    expect(writeDocument(parsed(exported, registry), registry)).toBe(exported);
  });

  test("requires text and paired inline content", () => {
    for (const source of ["Read {% tooltip %}help{% /tooltip %}.", '{% tooltip text="Help" /%}']) {
      const result = parseDocument(source, registry);
      expect(result).toMatchObject({ ok: false, source });
    }
  });

  test("refuses block children in a tooltip", () => {
    const document = parsed('Read {% tooltip text="Help" %}here{% /tooltip %}.', registry);
    const paragraph = document.children[0];
    if (paragraph.type !== "paragraph") throw new Error("Expected paragraph");
    const tooltip = paragraph.children[1];
    if (tooltip.type !== "topikComponent") throw new Error("Expected tooltip");
    tooltip.children = [{ type: "paragraph", children: [{ type: "text", value: "here" }] }];
    expect(() => writeDocument(document, registry)).toThrow(
      "tooltip may contain only inline children",
    );
  });
});

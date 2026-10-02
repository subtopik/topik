import { describe, expect, test } from "vite-plus/test";
import { parseDocument, writeDocument } from "../index.js";
import { withoutPositions, parse } from "../test-helpers.js";

describe("tabs source contract", () => {
  test("writes two ordered tab panels without changing their bodies", () => {
    const source =
      '{% tabs %}\n\n{% tab title="First" %}\n\nOne.\n\n{% /tab %}\n\n{% tab title="Second" %}\n\n- Two\n- Three\n\n{% /tab %}\n\n{% /tabs %}';
    const document = parse(source);
    expect(document.children[0]).toMatchObject({
      type: "topikComponent",
      name: "tabs",
      children: [
        { name: "tab", props: { title: "First" }, children: [{ type: "paragraph" }] },
        { name: "tab", props: { title: "Second" }, children: [{ type: "list" }] },
      ],
    });
    const written = writeDocument(document);
    expect(withoutPositions(parse(written).children)).toEqual(withoutPositions(document.children));
    expect(writeDocument(parse(written))).toBe(written);
  });

  test.each([
    ["{% tabs %}\n\n{% /tabs %}", "tabs requires at least one tab child"],
    ["{% tabs %}\n\nPlain text.\n\n{% /tabs %}", "tabs may contain only tab children"],
  ])("refuses invalid tab sets while retaining source", (source, message) => {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics.map((item) => item.message)).toContain(message);
  });
});

describe("tab source contract", () => {
  test("preserves an explicitly empty title and block content", () => {
    const source =
      '{% tabs %}\n\n{% tab title="" %}\n\n**Start** here.\n\n{% /tab %}\n\n{% /tabs %}';
    const document = parse(source);
    expect(document.children[0]).toMatchObject({
      name: "tabs",
      children: [{ name: "tab", props: { title: "" }, children: [{ type: "paragraph" }] }],
    });
    const written = writeDocument(document);
    expect(withoutPositions(parse(written).children)).toEqual(withoutPositions(document.children));
  });

  test.each([
    ['{% tab title="Loose" %}\n\nText.\n\n{% /tab %}', "tab must be inside tabs"],
    [
      "{% tabs %}\n\n{% tab %}\n\nText.\n\n{% /tab %}\n\n{% /tabs %}",
      "Missing attribute title on tab",
    ],
  ])("refuses invalid tab placement or properties while retaining source", (source, message) => {
    const result = parseDocument(source);
    expect(result).toMatchObject({ ok: false, source });
    if (!result.ok) expect(result.diagnostics.map((item) => item.message)).toContain(message);
  });

  test("refuses direct inline children in a tab body", () => {
    const document = parse(
      '{% tabs %}\n\n{% tab title="One" %}\n\nText.\n\n{% /tab %}\n\n{% /tabs %}',
    );
    const tabs = document.children[0];
    if (tabs.type !== "topikComponent") throw new Error("Expected tabs");
    const tab = tabs.children[0];
    if (tab.type !== "topikComponent") throw new Error("Expected tab");
    tab.children = [{ type: "text", value: "Text." }];
    expect(() => writeDocument(document)).toThrow("tab may contain only block children");
  });
});

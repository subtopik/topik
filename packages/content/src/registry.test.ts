import { expect, test } from "vite-plus/test";
import { components, getEffectiveProps, type Registry } from "./index.js";
import { topikComponents } from "./registry.js";

test("registry defaults are derived without changing authored values", () => {
  const registry: Registry = {
    ...components,
    notice: {
      kind: "block",
      attributes: { label: { type: "string", default: "Note" } },
      children: "blocks",
      render: false,
    },
  };
  const authored = { name: "notice", props: {} };
  expect(getEffectiveProps(authored, registry)).toEqual({ label: "Note" });
  expect(authored.props).toEqual({});
  expect(getEffectiveProps({ name: "notice", props: { label: "" } }, registry)).toEqual({
    label: "",
  });
});

test("the complete legacy catalog maps authored tags and native Markdown nodes", () => {
  expect(Object.keys(topikComponents).sort()).toEqual(
    [
      "accordion",
      "badge",
      "callout",
      "card",
      "cardGrid",
      "choice",
      "codeBlock",
      "codeGroup",
      "codeTab",
      "explanation",
      "figure",
      "image",
      "inlineCode",
      "link",
      "math",
      "mathInline",
      "mermaid",
      "question",
      "quiz",
      "step",
      "steps",
      "tab",
      "table",
      "tableCell",
      "tableHeader",
      "tableRow",
      "tabs",
      "underline",
    ].sort(),
  );
  expect(topikComponents.codeGroup.requiredChildren).toEqual(["codeTab"]);
  expect(topikComponents.codeTab.requiredChildren).toEqual(["fence"]);
  expect(topikComponents.figure.attributes?.darkSrc?.assetReference).toEqual({
    slot: "figure.darkSrc",
    role: "image-dark",
  });
  expect(topikComponents.link.attributes?.href?.assetReference).toEqual({
    slot: "link.href",
    role: "download",
    conditional: "proven-download",
  });
  expect(components.u).toBe(components.underline);
  expect(Object.isFrozen(components)).toBe(true);
  expect(Object.isFrozen(components.question.attributes.type.values)).toBe(true);
});

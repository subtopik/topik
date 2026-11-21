import { expect, test } from "vite-plus/test";
import { components, type Registry } from "./index.js";
import { getEffectiveProps } from "./registry.js";

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

test("the registry is frozen and declares asset reference slots", () => {
  expect(components.figure.attributes.darkSrc?.assetReference).toEqual({
    slot: "figure.darkSrc",
    role: "image-dark",
  });
  expect(components.u).toBe(components.underline);
  expect(Object.isFrozen(components)).toBe(true);
  expect(Object.isFrozen(components.question.attributes.type.values)).toBe(true);
});

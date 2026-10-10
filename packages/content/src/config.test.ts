import { expect, test, vi } from "vite-plus/test";
import { mergeTopikContentConfig, type TopikContentConfig } from "./config.js";
import { parseDocument } from "./markdown.js";
import { compileTopikContent } from "./compile.js";

test("custom string attributes can explicitly admit escaped whitespace", () => {
  const config: TopikContentConfig = {
    components: {
      formula: {
        kind: "block",
        render: "Formula",
        children: "none",
        selfClosing: true,
        attributes: { content: { type: "string", required: true, escapedWhitespace: true } },
      },
    },
  };
  expect(compileTopikContent('{% formula content="a\\nb\\tc" /%}', { config }).ok).toBe(true);
  for (const attribute of [
    { type: "string", escapedWhitespace: "yes" },
    { type: "enum", values: ["one"], escapedWhitespace: true },
    { type: "number", escapedWhitespace: false },
  ]) {
    expect(() =>
      mergeTopikContentConfig({
        components: {
          formula: { ...config.components!.formula!, attributes: { content: attribute } },
        },
      } as never),
    ).toThrow("Content configuration is invalid");
  }
});

test.each(["if", "else"])("rejects the reserved component name %s during configuration", (name) => {
  const config: TopikContentConfig = {
    components: {
      [name]: { kind: "block", render: "Notice", attributes: {}, children: "blocks" },
    },
  };
  expect(() => mergeTopikContentConfig(config)).toThrow("Content configuration is invalid");
  expect(compileTopikContent("Hello", { config })).toMatchObject({
    ok: false,
    source: "Hello",
    diagnostics: [{ id: "topik-config-invalid" }],
  });
});

test("custom asset declarations require string values", () => {
  for (const attribute of [
    { type: "number", asset: true },
    { type: "boolean", assetReference: { slot: "media.src", role: "image" } },
  ]) {
    expect(() =>
      mergeTopikContentConfig({
        components: {
          media: {
            kind: "block",
            render: "Media",
            children: "none",
            attributes: { src: attribute },
          },
        },
      } as never),
    ).toThrow("Content configuration is invalid");
  }
});

test("configuration rejects excessive depth before recursive cloning", () => {
  let nested: Record<string, unknown> = {};
  for (let index = 0; index < 10_000; index++) nested = { next: nested };
  expect(() => mergeTopikContentConfig({ variables: nested })).toThrow(
    "Content configuration is invalid",
  );
});

test("additive declarative schemas are isolated from caller mutation", () => {
  const custom = {
    kind: "block" as const,
    render: "Notice",
    attributes: { label: { type: "string" as const, required: true } },
    children: "blocks" as const,
  };
  const merged = mergeTopikContentConfig({ components: { notice: custom } });
  custom.attributes.label.required = false;
  expect(
    parseDocument('{% notice label="Safe" %}\n\nBody.\n\n{% /notice %}', merged.components).ok,
  ).toBe(true);
  const invalid = parseDocument("{% notice %}\n\nBody.\n\n{% /notice %}", merged.components);
  expect(invalid).toMatchObject({ ok: false });
  if (!invalid.ok)
    expect(invalid.diagnostics.map((item) => item.id)).toContain("attribute-missing-required");
});

test("a custom config cannot replace the canonical callout contract", () => {
  const merged = mergeTopikContentConfig({
    components: {
      callout: { kind: "block", render: "Unsafe", attributes: {}, children: "none" },
    },
  });
  expect(merged.components.callout.render).toBe("TopikCallout");
  const source = '{% callout variant="unknown" %}\n\nBody.\n\n{% /callout %}';
  expect(parseDocument(source, merged.components)).toMatchObject({ ok: false, source });
});

test("custom schemas reject executable callbacks in types and at runtime", () => {
  const validate = vi.fn(() => []);
  const config: TopikContentConfig = {
    components: {
      notice: {
        kind: "block",
        render: "Notice",
        attributes: {},
        children: "blocks",
        // @ts-expect-error Custom configuration accepts declarative schemas only.
        validate,
      },
    },
  };
  expect(() => mergeTopikContentConfig(config)).toThrow("Content configuration is invalid");
  expect(validate).not.toHaveBeenCalled();
});

test("config refuses accessor-backed, sparse, cyclic, and foreign data", () => {
  const accessor = Object.defineProperty({}, "name", {
    get() {
      throw new Error("read");
    },
    enumerable: true,
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = "one";
  for (const config of [
    { variables: accessor },
    { variables: cyclic },
    { variables: { items: sparse } },
    { variables: { date: new Date(0) } },
    { functions: { arbitrary: () => true } },
  ])
    expect(() => mergeTopikContentConfig(config as never)).toThrow(
      "Content configuration is invalid",
    );
});

test("a numeric default must satisfy its own bounds and integer constraint", () => {
  for (const defaultValue of [0, 5, 1.5]) {
    expect(() =>
      mergeTopikContentConfig({
        components: {
          gallery: {
            kind: "block",
            render: "Gallery",
            attributes: {
              columns: { type: "number", min: 1, max: 4, integer: true, default: defaultValue },
            },
            children: "none",
          },
        },
      }),
    ).toThrow("Content configuration is invalid");
  }
  expect(
    mergeTopikContentConfig({
      components: {
        gallery: {
          kind: "block",
          render: "Gallery",
          attributes: { columns: { type: "number", min: 1, max: 4, integer: true, default: 4 } },
          children: "none",
        },
      },
    }).components.gallery.attributes.columns.default,
  ).toBe(4);
});

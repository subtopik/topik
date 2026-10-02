import { expect, test, vi } from "vite-plus/test";
import {
  formatTopikContent,
  rewriteTopikAssetOccurrences,
  topikAssetReferenceSlots,
  validateTopikContent,
  type TopikContentConfig,
} from "./index.js";

test("public asset metadata cannot be mutated to bypass image admission", () => {
  const slot = topikAssetReferenceSlots[0];
  try {
    Reflect.set(slot, "node", "link");
    expect(validateTopikContent("![image](javascript:alert)").valid).toBe(false);
  } finally {
    Reflect.set(slot, "node", "image");
  }
});

const config: TopikContentConfig = {
  components: {
    media: {
      kind: "block",
      render: "Media",
      children: "none",
      attributes: {
        src: { type: "string", asset: true },
        poster: {
          type: "string",
          assetReference: { slot: "media.poster", role: "image" },
        },
        label: { type: "string" },
      },
    },
  },
};

test.each(["src", "poster"])("custom %s assets use source URL admission", (property) => {
  for (const value of [
    "javascript:alert(1)",
    "http://example.test/image",
    "https://user:secret@example.test/image",
    "//example.test/image",
    "images/%2fescape.png",
  ]) {
    const source = `{% media ${property}="${value}" /%}`;
    const result = validateTopikContent(source, { config });
    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors[0].type).toBe(`media.${property}`);
    expect(JSON.stringify(result.errors)).not.toContain(value);
    expect(formatTopikContent(source, { config })).toMatchObject({ ok: false, source });
    const replace = vi.fn();
    expect(rewriteTopikAssetOccurrences(source, replace, { config })).toMatchObject({
      ok: false,
      source,
    });
    expect(replace).not.toHaveBeenCalled();
  }
});

test("custom asset defaults and inactive branches are validated", () => {
  const withDefault: TopikContentConfig = {
    components: {
      media: {
        ...config.components!.media,
        attributes: { src: { type: "string", asset: true, default: "javascript:alert(1)" } },
      },
    },
  };
  expect(validateTopikContent("{% media /%}", { config: withDefault }).valid).toBe(false);
  const source = '{% if false %}\n\n{% media src="javascript:alert(1)" /%}\n\n{% /if %}';
  expect(validateTopikContent(source, { config }).valid).toBe(false);
});

test("custom assets preserve safe values and compiled-output boundaries", () => {
  for (const value of ["images/photo.png", "https://example.test/photo.png?signature=abc"]) {
    const source = `{% media src="${value}" poster="${value}" /%}`;
    expect(validateTopikContent(source, { config })).toMatchObject({ valid: true });
  }
  const source = `{% media src="asset:auto-v1-${"a".repeat(52)}" /%}`;
  expect(validateTopikContent(source, { config }).valid).toBe(false);
  expect(validateTopikContent(source, { config, allowCompiledAssetReferences: true }).valid).toBe(
    true,
  );
  // A property is an asset only when the schema explicitly declares it as one.
  expect(validateTopikContent('{% media label="javascript:literal" /%}', { config }).valid).toBe(
    true,
  );
});

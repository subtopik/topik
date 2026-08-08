import { describe, expect, test } from "vite-plus/test";
import type { AssetManifestV1 } from "@topik/schema";
import {
  TOPIK_ASSET_DEFAULT_CAPABILITIES,
  parseAssetManifest,
  parseStrictTopikJson,
  serializeAssetManifest,
  serializeTopikJson,
  validateAssetManifestValue,
} from "./index";

function emptyManifest(): AssetManifestV1 {
  return {
    apiVersion: "v1",
    assets: {},
    pathRules: "topik-path-v1",
    referenceRules: "topik-asset-reference-v1",
    resource: { apiVersion: "v1", name: "guide", path: "guide.json", type: "Guide" },
    serializer: "topik-json-v1",
    type: "AssetManifest",
  };
}

function manifestWithSpdx(spdxExpression: string): AssetManifestV1 {
  return {
    ...emptyManifest(),
    assets: {
      ast_00000000000000000000000000: {
        digest: { algorithm: "sha256", value: "0".repeat(64) },
        license: { spdxExpression },
        mediaType: "application/octet-stream",
        path: "files/license.bin",
        size: 0,
      },
    },
  };
}

describe("topik-json-v1", () => {
  test("uses exact two-space canonical bytes and UTF-16 member ordering", () => {
    expect(serializeTopikJson({ z: {}, a: [1], "\ue000": 2, "😀": 3 })).toBe(
      '{\n  "a": [\n    1\n  ],\n  "z": {},\n  "😀": 3,\n  "": 2\n}\n',
    );
    const serialized = serializeAssetManifest(emptyManifest());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(new TextDecoder().decode(serialized.value)).toBe(
      '{\n  "apiVersion": "v1",\n  "assets": {},\n  "pathRules": "topik-path-v1",\n  "referenceRules": "topik-asset-reference-v1",\n  "resource": {\n    "apiVersion": "v1",\n    "name": "guide",\n    "path": "guide.json",\n    "type": "Guide"\n  },\n  "serializer": "topik-json-v1",\n  "type": "AssetManifest"\n}\n',
    );
  });

  test("preserves __proto__ members as ordinary own JSON data", () => {
    const source = '{"__proto__":{"polluted":true},"nested":{"__proto__":"kept"}}';
    const parsed = parseStrictTopikJson(source) as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed.__proto__)).toBeNull();
    const nested = parsed.nested as Record<string, unknown>;
    expect(Object.hasOwn(nested, "__proto__")).toBe(true);
    expect(nested.__proto__).toBe("kept");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    const reparsed = parseStrictTopikJson(serializeTopikJson(parsed)) as Record<string, unknown>;
    expect(Object.hasOwn(reparsed, "__proto__")).toBe(true);
    expect(Object.hasOwn(reparsed.nested as object, "__proto__")).toBe(true);
  });

  test("rejects inherited manifest data and reparses every successful serialization", () => {
    const inheritedManifest = Object.create(emptyManifest()) as AssetManifestV1;
    expect(validateAssetManifestValue(inheritedManifest)).toMatchObject({ ok: false });
    expect(serializeAssetManifest(inheritedManifest)).toMatchObject({ ok: false });
    expect(() => serializeTopikJson(inheritedManifest)).toThrow(/serializable|prototype/u);

    const serialized = serializeAssetManifest(emptyManifest());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(parseAssetManifest(serialized.value)).toMatchObject({ ok: true });
  });

  test("rejects duplicate members and malformed/non-integer numbers before schema validation", () => {
    const duplicate = '{"apiVersion":"v1","apiVersion":"v1"}';
    expect(() => parseStrictTopikJson(duplicate)).toThrow(/Duplicate/u);
    const result = parseAssetManifest(duplicate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0].id).toBe("TOPIK_ASSET_MANIFEST_DUPLICATE_MEMBER");
    expect(() => parseStrictTopikJson('{"n":1.0}')).toThrow(/nonnegative integers/u);
    expect(() => parseStrictTopikJson('{"n":1e2}')).toThrow(/nonnegative integers/u);
    expect(() => parseStrictTopikJson('{"n":-0}')).toThrow(/nonnegative integers/u);
    expect(() => parseStrictTopikJson("{/*no*/}")).toThrow();
  });

  test("keeps escaped control and bidi member names out of diagnostic fields", () => {
    const source = '{"\\u001b\\u202e":"first","\\u001b\\u202e":"second"}';
    const result = parseAssetManifest(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.source).toEqual(new TextEncoder().encode(source));
    expect(result.diagnostics[0].id).toBe("TOPIK_ASSET_MANIFEST_DUPLICATE_MEMBER");

    for (const value of diagnosticStrings(result.diagnostics)) {
      expect(value).not.toMatch(/[\p{Cc}\p{Bidi_Control}]/u);
    }
  });

  test("enforces raw-byte, BOM, and depth limits", () => {
    expect(parseAssetManifest(new Uint8Array(16_777_217))).toMatchObject({ ok: false });
    expect(parseAssetManifest(`\ufeff${serializeTopikJson(emptyManifest())}`)).toMatchObject({
      ok: false,
    });
    expect(() => parseStrictTopikJson("[[[[[[[[[]]]]]]]]]", 8)).toThrow(/depth/u);
  });

  test("propagates binding-root context through the 768-byte complete-path boundary", () => {
    const manifest = emptyManifest();
    const serialized = serializeAssetManifest(manifest);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const atBoundary = "b".repeat(757);
    const overBoundary = "b".repeat(758);
    expect(
      validateAssetManifestValue(manifest, TOPIK_ASSET_DEFAULT_CAPABILITIES, {
        bindingRoot: atBoundary,
      }),
    ).toMatchObject({ ok: true });
    expect(parseAssetManifest(serialized.value, { bindingRoot: atBoundary })).toMatchObject({
      ok: true,
    });
    expect(
      serializeAssetManifest(manifest, TOPIK_ASSET_DEFAULT_CAPABILITIES, {
        bindingRoot: overBoundary,
      }),
    ).toMatchObject({ ok: false });
    expect(parseAssetManifest(serialized.value, { bindingRoot: overBoundary })).toMatchObject({
      ok: false,
    });
  });

  test("enforces portable maxima even with a caller-crafted capability object", () => {
    const permissive = {
      ...TOPIK_ASSET_DEFAULT_CAPABILITIES,
      maxAssets: 100_000,
      maxComponentUtf8Bytes: 10_000,
      maxComponents: 1_000,
      maxJsonDepth: 100,
      maxManifestBytes: 100_000_000,
      maxRepositoryPathUtf8Bytes: 100_000,
    };
    expect(
      parseAssetManifest(new Uint8Array(16_777_217), { capabilities: permissive }),
    ).toMatchObject({ ok: false });

    const assets: AssetManifestV1["assets"] = {};
    for (let index = 0; index < 8_500; index++) {
      assets[`ast_${String(index).padStart(26, "0")}`] = {
        attribution: { text: "x".repeat(2_048) },
        digest: { algorithm: "sha256", value: "0".repeat(64) },
        mediaType: "application/octet-stream",
        path: `files/${index}.bin`,
        size: 0,
      };
    }
    expect(serializeAssetManifest({ ...emptyManifest(), assets }, permissive)).toMatchObject({
      ok: false,
    });
  });

  test("validates SPDX 2.3 license IDs, exceptions, custom references, and precedence", () => {
    for (const expression of [
      "(MIT OR Apache-2.0) AND LicenseRef-Proprietary",
      "DocumentRef-acme:LicenseRef-Proprietary OR BSD-3-Clause",
      "GPL-2.0-only WITH Classpath-exception-2.0",
      "MIT OR Apache-2.0 AND BSD-3-Clause",
    ]) {
      expect(validateAssetManifestValue(manifestWithSpdx(expression))).toMatchObject({ ok: true });
    }

    for (const expression of [
      "Totally-Fake-License",
      "GPL-2.0-only WITH Totally-Fake-Exception",
      "(MIT OR Apache-2.0) WITH Classpath-exception-2.0",
      "MIT AND OR Apache-2.0",
      "LicenseRef-",
    ]) {
      expect(validateAssetManifestValue(manifestWithSpdx(expression))).toMatchObject({ ok: false });
    }
  });

  test.each(["guide.json", "GUIDE.JSON", "guide.json/assets"])(
    "rejects asset ownership that collides with the resource descriptor path %s",
    (path) => {
      const value = manifestWithSpdx("MIT");
      value.assets.ast_00000000000000000000000000.path = path;
      expect(validateAssetManifestValue(value)).toMatchObject({
        ok: false,
        diagnostics: [{ id: "TOPIK_ASSET_PATH_COLLISION" }],
      });
    },
  );

  test("rejects semantically valid noncanonical bytes without rewriting them", () => {
    const compact = JSON.stringify(emptyManifest());
    const result = parseAssetManifest(compact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.source).toEqual(new TextEncoder().encode(compact));
    expect(result.diagnostics[0].id).toBe("TOPIK_ASSET_MANIFEST_NON_CANONICAL");
  });

  test.each([
    ["apiVersion", "v9", "TOPIK_ASSET_MANIFEST_UNSUPPORTED_VERSION"],
    ["serializer", "topik-json-v9", "TOPIK_ASSET_MANIFEST_UNSUPPORTED_SERIALIZER"],
    ["pathRules", "topik-path-v9", "TOPIK_ASSET_MANIFEST_UNSUPPORTED_PATH_RULES"],
    [
      "referenceRules",
      "topik-asset-reference-v9",
      "TOPIK_ASSET_MANIFEST_UNSUPPORTED_REFERENCE_RULES",
    ],
  ])("reports a stable diagnostic for unknown %s", (field, value, id) => {
    const manifest = { ...emptyManifest(), [field]: value };
    const result = parseAssetManifest(serializeTopikJson(manifest));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0].id).toBe(id);
  });
});

function diagnosticStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(diagnosticStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(diagnosticStrings);
  }
  return [];
}

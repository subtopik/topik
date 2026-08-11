import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, test } from "vite-plus/test";
import {
  assetV1Schema,
  GENERATED_ASSET_NAME_PATTERN,
  hasMatchingAssetDigests,
  isGeneratedAssetName,
  parseGeneratedAssetName,
} from "./asset";
import { testSchema } from "./test-utils";

const ajv = new Ajv2020({ strict: true, strictRequired: false });
const validateAsset = ajv.compile(assetV1Schema);
const validateAssetContract = (value: unknown): boolean =>
  validateAsset(value) && hasMatchingAssetDigests(value);
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
testSchema("asset", validateAssetContract);

describe("Asset/v1 raw schema", () => {
  test("ships the raw compiler-output schema without source/dist drift", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dirname, "asset-v1.json"), "utf8"));
    expect(assetV1Schema).toEqual(raw);
    expect(raw.$id).toBe("https://topik.dev/schemas/asset/v1.json");
    expect(raw.$comment).toContain("spec.uri");
  });

  test("accepts only complete compiler-derived descriptors", () => {
    const digest = "0".repeat(64);
    const output = {
      apiVersion: "v1",
      type: "Asset",
      name: `auto-v1-${"a".repeat(52)}`,
      spec: {
        uri: `assets/sha256/${digest}`,
        integrity: `sha256:${digest}`,
        mediaType: "application/pdf",
        size: 268_435_456,
      },
    };
    expect(validateAsset(output)).toBe(true);
    expect(hasMatchingAssetDigests(output)).toBe(true);
    expect(
      hasMatchingAssetDigests({
        ...output,
        spec: { ...output.spec, integrity: `sha256:${"f".repeat(64)}` },
      }),
    ).toBe(false);
    expect(validateAsset({ ...output, name: "manual" })).toBe(false);
    expect(validateAsset({ ...output, spec: { uri: "manual.pdf" } })).toBe(false);
    expect(validateAsset({ ...output, spec: { ...output.spec, size: 268_435_457 } })).toBe(false);
  });

  test("enforces canonical full-SHA-256 base32 generated names", () => {
    for (const finalSymbol of BASE32_ALPHABET) {
      expect(validateAsset(assetWithName(`auto-v1-${"a".repeat(51)}${finalSymbol}`))).toBe(
        finalSymbol === "a" || finalSymbol === "q",
      );
    }
    for (const name of [
      `auto-v1-${"a".repeat(51)}`,
      `auto-v1-${"a".repeat(53)}`,
      `auto-v1-${"a".repeat(51)}0`,
      `auto-v1-${"a".repeat(51)}A`,
      `auto-v1-${"a".repeat(52)}=`,
      `AUTO-v1-${"a".repeat(52)}`,
    ]) {
      expect(validateAsset(assetWithName(name)), name).toBe(false);
    }
  });

  test("brands generated names only through runtime validation", () => {
    const canonical = `auto-v1-${"a".repeat(52)}`;
    expect(isGeneratedAssetName(canonical)).toBe(true);
    expect(parseGeneratedAssetName(canonical)).toBe(canonical);
    expect(isGeneratedAssetName("auto-v1-q")).toBe(false);
    expect(() => parseGeneratedAssetName("auto-v1-q")).toThrow(
      "Generated Asset name is not canonical",
    );
  });

  test("isolates opaque admission from mutation of the public pattern descriptor", () => {
    const originalTest = GENERATED_ASSET_NAME_PATTERN.test.bind(GENERATED_ASSET_NAME_PATTERN);
    GENERATED_ASSET_NAME_PATTERN.test = () => true;
    try {
      expect(isGeneratedAssetName("auto-v1-q")).toBe(false);
      expect(() => parseGeneratedAssetName("auto-v1-q")).toThrow(
        "Generated Asset name is not canonical",
      );
    } finally {
      GENERATED_ASSET_NAME_PATTERN.test = originalTest;
    }
  });
});

function assetWithName(name: string): unknown {
  const digest = "0".repeat(64);
  return {
    apiVersion: "v1",
    type: "Asset",
    name,
    spec: {
      uri: `assets/sha256/${digest}`,
      integrity: `sha256:${digest}`,
      mediaType: "application/pdf",
      size: 0,
    },
  };
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, test } from "vite-plus/test";
import { assetV1Schema, hasMatchingAssetDigests } from "./asset";
import { testSchema } from "./test-utils";

const ajv = new Ajv2020({ strict: true, strictRequired: false });
const validateAsset = ajv.compile(assetV1Schema);
const validateAssetContract = (value: unknown): boolean =>
  validateAsset(value) && hasMatchingAssetDigests(value);
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
});

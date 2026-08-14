import Ajv2020 from "ajv/dist/2020";
import { describe, expect, test } from "vite-plus/test";
import { testSchema } from "../test-utils";
import rawAssetV1Schema from "./v1.json" with { type: "json" };

const ajv = new Ajv2020({ strict: true, strictRequired: false });
const validateAsset = ajv.compile(rawAssetV1Schema);
testSchema("asset", validateAsset);

describe("Asset/v1 schema", () => {
  test("has the canonical versioned schema identifier", () => {
    expect(rawAssetV1Schema.$id).toBe("https://topik.dev/schemas/asset/v1.json");
  });

  test("requires only uri in spec", () => {
    expect(
      validateAsset({
        apiVersion: "v1",
        type: "Asset",
        name: "company-logo",
        spec: { uri: "https://cdn.example.com/company-logo.pdf" },
      }),
    ).toBe(true);
    expect(validateAsset({ apiVersion: "v1", type: "Asset", name: "company-logo", spec: {} })).toBe(
      false,
    );
  });

  test("keeps optional metadata open-ended where specified", () => {
    expect(
      validateAsset({
        apiVersion: "v1",
        type: "Asset",
        name: "metadata",
        labels: { topic: "manuals" },
        spec: {
          uri: "custom:asset",
          integrity: `sha512:${"a".repeat(128)}`,
          mediaType: "application/vnd.example+json",
          size: 268_435_456,
        },
      }),
    ).toBe(true);
  });

  test("enforces the resource-name grammar", () => {
    const asset = (name: string) => ({
      apiVersion: "v1",
      type: "Asset",
      name,
      spec: { uri: "asset.bin" },
    });
    for (const name of ["manual", "company-logo", `auto-v1-${"a".repeat(52)}`]) {
      expect(validateAsset(asset(name)), name).toBe(true);
    }
    for (const name of [
      "Company-logo",
      "company_logo",
      "-company-logo",
      "company-logo-",
      "company--logo",
      "a".repeat(64),
    ]) {
      expect(validateAsset(asset(name)), name).toBe(false);
    }
  });
});

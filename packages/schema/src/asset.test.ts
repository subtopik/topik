import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, test } from "vite-plus/test";
import { assetV1Schema, type AssetLicense } from "./asset";
import { testSchema } from "./test-utils";

const ajv = new Ajv2020({ strict: true, strictRequired: false });
ajv.addFormat("topik-asset-uri-v1", (value) =>
  value.startsWith("https://")
    ? !/[?#]/u.test(value)
    : !value.startsWith("/") && !value.includes("..") && !value.includes("\\"),
);
ajv.addFormat("topik-plain-text-v1", (value) => value.trim() === value);
ajv.addFormat(
  "topik-https-url-v1",
  (value) => value.startsWith("https://") && !/[?#]/u.test(value),
);
ajv.addFormat("spdx-expression-2.3", () => true);

const validateAsset = ajv.compile(assetV1Schema);
testSchema("asset", validateAsset);

describe("Asset/v1 raw schema", () => {
  test("ships the immutable raw schema without source/dist drift", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dirname, "asset-v1.json"), "utf8"));
    expect(assetV1Schema).toEqual(raw);
    expect(raw.$id).toBe("https://topik.dev/schemas/asset/v1.json");
  });

  test("requires at least one safe license field in TypeScript", () => {
    const licenses: AssetLicense[] = [
      { spdxExpression: "MIT" },
      { url: "https://example.com/license" },
      { spdxExpression: "MIT", url: "https://example.com/license" },
    ];
    expect(licenses).toHaveLength(3);
    // @ts-expect-error Asset/v1 does not permit an empty license object.
    const invalid: AssetLicense = {};
    void invalid;
  });

  test("caps declared remote size at the portable 256 MiB boundary", () => {
    const remote = {
      apiVersion: "v1",
      type: "Asset",
      name: "remote",
      spec: {
        uri: "https://cdn.example.com/revisions/manual.pdf",
        integrity: `sha256:${"0".repeat(64)}`,
        mediaType: "application/pdf",
        size: 268_435_456,
      },
    };
    expect(validateAsset(remote)).toBe(true);
    expect(validateAsset({ ...remote, spec: { ...remote.spec, size: 268_435_457 } })).toBe(false);
  });
});

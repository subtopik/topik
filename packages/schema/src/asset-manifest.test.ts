import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, test } from "vite-plus/test";
import { assetManifestV1Schema, type AssetManifestLicenseV1 } from "./asset-manifest";
import { guideSchema } from "./guide";
import { guideV2Schema } from "./guide-v2";
import { wikiPageSchema } from "./wiki-page";
import { wikiPageV2Schema } from "./wiki-page-v2";

const canonicalExample = {
  apiVersion: "v1",
  assets: {
    ast_04w6m8r2n5cx3d7kg9p1tvhzfj: {
      attribution: {
        creator: "Ada Example",
        sourceUrl: "https://example.com/original",
        text: "Photo by Ada Example",
        title: "Example hero image",
      },
      digest: {
        algorithm: "sha256",
        value: "9d4e1e23bd5b727046a9e3b4b7db57bd8d6ee684f01d9be2f96d10cacc602a53",
      },
      license: {
        spdxExpression: "CC-BY-4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
      },
      mediaType: "image/png",
      path: "assets/getting-started/hero.png",
      size: 48123,
    },
  },
  pathRules: "topik-path-v1",
  referenceRules: "topik-asset-reference-v1",
  resource: { apiVersion: "v1", name: "getting-started", path: "wiki.yaml", type: "Wiki" },
  serializer: "topik-json-v1",
  type: "AssetManifest",
};

const validLicenseTypes: readonly AssetManifestLicenseV1[] = [
  { spdxExpression: "MIT" },
  { url: "https://example.com/license" },
  { spdxExpression: "MIT", url: "https://example.com/license" },
];
// @ts-expect-error AssetManifest/v1 requires at least one portable license field.
const invalidEmptyLicenseType: AssetManifestLicenseV1 = {};
void invalidEmptyLicenseType;

const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const name of [
  "topik-path-v1",
  "topik-plain-text-v1",
  "topik-https-url-v1",
  "spdx-expression-2.3",
]) {
  ajv.addFormat(name, () => true);
}
const validate = ajv.compile(assetManifestV1Schema);

describe("AssetManifest/v1 schema artifact", () => {
  test("keeps the runtime constant structurally identical to the shipped raw JSON", () => {
    const raw = JSON.parse(
      readFileSync(join(import.meta.dirname, "asset-manifest-v1.json"), "utf8"),
    );
    expect(assetManifestV1Schema).toEqual(raw);
    expect(raw.$id).toBe("https://topik.dev/schemas/asset-manifest/v1.json");
  });

  test("accepts the normative canonical example", () => {
    expect(validate(canonicalExample), JSON.stringify(validate.errors)).toBe(true);
    expect(validLicenseTypes).toHaveLength(3);
  });

  test.each([
    ["unknown top-level member", { ...canonicalExample, unknown: true }],
    [
      "unknown nested member",
      {
        ...canonicalExample,
        assets: {
          ...canonicalExample.assets,
          ast_04w6m8r2n5cx3d7kg9p1tvhzfj: {
            ...canonicalExample.assets.ast_04w6m8r2n5cx3d7kg9p1tvhzfj,
            unknown: true,
          },
        },
      },
    ],
    [
      "nullable optional",
      {
        ...canonicalExample,
        assets: {
          ...canonicalExample.assets,
          ast_04w6m8r2n5cx3d7kg9p1tvhzfj: {
            ...canonicalExample.assets.ast_04w6m8r2n5cx3d7kg9p1tvhzfj,
            license: null,
          },
        },
      },
    ],
    [
      "invalid size limit",
      {
        ...canonicalExample,
        assets: {
          ...canonicalExample.assets,
          ast_04w6m8r2n5cx3d7kg9p1tvhzfj: {
            ...canonicalExample.assets.ast_04w6m8r2n5cx3d7kg9p1tvhzfj,
            size: 9007199254740992,
          },
        },
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(validate(value)).toBe(false);
  });

  test("enforces the 10,000-entry schema limit", () => {
    const entry = canonicalExample.assets.ast_04w6m8r2n5cx3d7kg9p1tvhzfj;
    const assets = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [
        `ast_0${String(index).padStart(25, "0")}`,
        entry,
      ]),
    );
    expect(validate({ ...canonicalExample, assets })).toBe(false);
  });
});

describe("portable target resource versions", () => {
  test("keeps v1 schemas intact and gives v2 immutable identities without spec.assets", () => {
    expect(guideSchema.properties.apiVersion.const).toBe("v1");
    expect(wikiPageSchema.properties.apiVersion.const).toBe("v1");
    expect(guideV2Schema.$id).toBe("https://topik.dev/schemas/guide/v2.json");
    expect(wikiPageV2Schema.$id).toBe("https://topik.dev/schemas/wiki-page/v2.json");
    expect(guideV2Schema.properties.spec.properties).not.toHaveProperty("assets");
    expect(wikiPageV2Schema.properties.spec.properties).not.toHaveProperty("assets");
    const validateGuideV2 = ajv.compile(guideV2Schema);
    expect(
      validateGuideV2({
        apiVersion: "v2",
        type: "Guide",
        name: "guide",
        spec: {
          title: "Guide",
          slug: "guide",
          content: { format: "topik", value: "# Guide\n" },
        },
      }),
    ).toBe(true);
    expect(
      validateGuideV2({
        apiVersion: "v2",
        type: "Guide",
        name: "guide",
        spec: {
          title: "Guide",
          slug: "guide",
          content: { format: "topik", value: "# Guide\n" },
          assets: [],
        },
      }),
    ).toBe(false);
  });
});

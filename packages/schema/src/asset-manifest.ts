import type { JSONSchema } from "json-schema-to-ts";
import rawAssetManifestV1Schema from "./asset-manifest-v1.json" with { type: "json" };

/** Immutable Draft 2020-12 schema published at `asset-manifest/v1.json`. */
export const assetManifestV1Schema: JSONSchema = rawAssetManifestV1Schema as JSONSchema;

export interface AssetManifestDigestV1 {
  algorithm: "sha256";
  value: string;
}

export type AssetManifestLicenseV1 =
  | { spdxExpression: string; url?: string }
  | { spdxExpression?: string; url: string };

export interface AssetManifestAttributionV1 {
  text: string;
  creator?: string;
  title?: string;
  sourceUrl?: string;
  copyrightNotice?: string;
}

export interface AssetManifestEntryV1 {
  digest: AssetManifestDigestV1;
  mediaType: string;
  path: string;
  size: number;
  license?: AssetManifestLicenseV1;
  attribution?: AssetManifestAttributionV1;
}

export interface AssetManifestResourceBindingV1 {
  apiVersion: string;
  name: string;
  path: string;
  type: string;
}

export interface AssetManifestV1 {
  apiVersion: "v1";
  assets: Record<string, AssetManifestEntryV1>;
  pathRules: "topik-path-v1";
  referenceRules: "topik-asset-reference-v1";
  resource: AssetManifestResourceBindingV1;
  serializer: "topik-json-v1";
  type: "AssetManifest";
}

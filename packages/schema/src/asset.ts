import type { JSONSchema } from "json-schema-to-ts";
import rawAssetV1Schema from "./asset-v1.json" with { type: "json" };

/** Immutable Draft 2020-12 schema published at `asset/v1.json`. */
export const assetV1Schema: JSONSchema = rawAssetV1Schema as JSONSchema;

/** Current writer schema. Kept as an alias for the original public export. */
export const assetSchema = assetV1Schema;

export type AssetLicense =
  | { spdxExpression: string; url?: string }
  | { spdxExpression?: string; url: string };

export interface AssetAttribution {
  text: string;
  creator?: string;
  title?: string;
  sourceUrl?: string;
  copyrightNotice?: string;
}

export interface AssetSpec {
  uri: string;
  integrity?: `sha256:${string}`;
  size?: number;
  mediaType?: string;
  license?: AssetLicense;
  attribution?: AssetAttribution;
}

export interface Asset {
  apiVersion: "v1";
  type: "Asset";
  name: string;
  labels?: Record<string, string>;
  spec: AssetSpec;
}

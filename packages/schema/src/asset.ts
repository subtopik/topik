import type { JSONSchema } from "json-schema-to-ts";
import rawAssetV1Schema from "./asset-v1.json" with { type: "json" };

/** Draft 2020-12 schema for compiler-produced `Asset/v1` resources. */
export const assetV1Schema: JSONSchema = rawAssetV1Schema as JSONSchema;

/** Current compiler-output schema. */
export const assetSchema = assetV1Schema;

export interface AssetSpec {
  uri: `assets/sha256/${string}`;
  integrity: `sha256:${string}`;
  size: number;
  mediaType: string;
}

export interface Asset {
  apiVersion: "v1";
  type: "Asset";
  name: `auto-v1-${string}`;
  spec: AssetSpec;
}

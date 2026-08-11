import type { JSONSchema } from "json-schema-to-ts";
import rawAssetV1Schema from "./asset-v1.json" with { type: "json" };

/** Draft 2020-12 schema for compiler-produced `Asset/v1` resources. */
export const assetV1Schema: JSONSchema = rawAssetV1Schema as JSONSchema;

/** Current compiler-output schema. */
export const assetSchema = assetV1Schema;

/** Canonical unpadded base32 encoding of a full SHA-256 with the versioned prefix. */
export type GeneratedAssetName = `auto-v1-${string}${"a" | "q"}`;

export interface AssetSpec {
  uri: `assets/sha256/${string}`;
  integrity: `sha256:${string}`;
  size: number;
  mediaType: string;
}

export interface Asset {
  apiVersion: "v1";
  type: "Asset";
  name: GeneratedAssetName;
  spec: AssetSpec;
}

/** Check the cross-field digest invariant that JSON Schema cannot express. */
export function hasMatchingAssetDigests(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("spec" in value)) return false;
  const { spec } = value;
  if (typeof spec !== "object" || spec === null || !("uri" in spec) || !("integrity" in spec)) {
    return false;
  }
  if (typeof spec.uri !== "string" || typeof spec.integrity !== "string") return false;
  const uri = /^assets\/sha256\/([0-9a-f]{64})$/u.exec(spec.uri);
  const integrity = /^sha256:([0-9a-f]{64})$/u.exec(spec.integrity);
  return uri !== null && integrity !== null && uri[1] === integrity[1];
}

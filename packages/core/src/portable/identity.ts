import { createHash } from "node:crypto";
import type { Asset } from "@topik/schema";
import { TOPIK_MATERIALIZATION_VERSION } from "./constants";
import { topikAssetDiagnostic, type TopikAssetResult } from "./diagnostics";
import { serializeTopikJson } from "./json";

export interface TopikAssetReferenceMappingV1 {
  resource: string;
  position: string;
  slot: string;
  name: string;
}

export interface TopikAssetSemanticRecordV1 {
  descriptor: "topik-asset-semantic-v1";
  assetNames: readonly string[];
  references: readonly TopikAssetReferenceMappingV1[];
}

export interface TopikMaterializationResourceV1 {
  resource: string;
  path: string;
  size: number;
  sha256: string;
}

export interface TopikMaterializationPayloadV1 {
  path: string;
  size: number;
  sha256: string;
  assetNames: readonly string[];
}

export interface TopikMaterializationRecordV1 {
  descriptor: "topik-materialization-v1";
  resources: readonly TopikMaterializationResourceV1[];
  payloads: readonly TopikMaterializationPayloadV1[];
}

export interface TopikMaterializationResourceInput {
  resource: { type: string; name: string };
  bytes: Uint8Array;
}

export interface TopikMaterializationPayloadInput {
  path: string;
  bytes: Uint8Array;
  assetNames: readonly string[];
}

export function createTopikAssetSemanticRecord(
  assets: readonly Asset[],
  references: readonly TopikAssetReferenceMappingV1[],
): TopikAssetSemanticRecordV1 {
  return {
    descriptor: "topik-asset-semantic-v1",
    assetNames: assets.map((asset) => asset.name).sort(compareUtf8),
    references: [...references].sort((left, right) =>
      compareUtf8(
        `${left.resource}\0${left.position}\0${left.slot}\0${left.name}`,
        `${right.resource}\0${right.position}\0${right.slot}\0${right.name}`,
      ),
    ),
  };
}

export function createTopikMaterializationRecord(
  resources: readonly TopikMaterializationResourceInput[],
  payloads: readonly TopikMaterializationPayloadInput[],
): TopikMaterializationRecordV1 {
  const resourceKeys = new Set<string>();
  const payloadPaths = new Set<string>();
  for (const input of resources) {
    const key = `${input.resource.type}/${input.resource.name}`;
    if (resourceKeys.has(key)) throw new TypeError("Materialization repeats a resource descriptor");
    resourceKeys.add(key);
  }
  for (const input of payloads) {
    if (payloadPaths.has(input.path)) throw new TypeError("Materialization repeats a payload path");
    payloadPaths.add(input.path);
  }
  return {
    descriptor: TOPIK_MATERIALIZATION_VERSION,
    resources: resources
      .map((input) => ({
        resource: `${input.resource.type}/${input.resource.name}`,
        path: `${input.resource.type}/${input.resource.name}.json`,
        size: input.bytes.byteLength,
        sha256: sha256(input.bytes),
      }))
      .sort((left, right) => compareUtf8(left.resource, right.resource)),
    payloads: payloads
      .map((input) => ({
        path: input.path,
        size: input.bytes.byteLength,
        sha256: sha256(input.bytes),
        assetNames: [...input.assetNames].sort(compareUtf8),
      }))
      .sort((left, right) => compareUtf8(left.path, right.path)),
  };
}

export function validateTopikMaterializationRecord(
  record: TopikMaterializationRecordV1,
  assets: readonly Asset[],
): TopikAssetResult<TopikMaterializationRecordV1> {
  const payloads = new Map(record.payloads.map((payload) => [payload.path, payload]));
  const descriptors = new Set(record.resources.map((resource) => resource.resource));
  const missing = assets.find(
    (asset) =>
      !descriptors.has(`Asset/${asset.name}`) ||
      (!asset.spec.uri.startsWith("https://") &&
        (!payloads.has(asset.spec.uri) ||
          !payloads.get(asset.spec.uri)?.assetNames.includes(asset.name) ||
          `sha256:${payloads.get(asset.spec.uri)?.sha256}` !== asset.spec.integrity ||
          payloads.get(asset.spec.uri)?.size !== asset.spec.size)),
  );
  if (missing !== undefined) {
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic(
          "TOPIK_ASSET_INVENTORY_INCOMPLETE",
          "Materialization omits or mismatches a required Asset descriptor or payload",
          { location: { key: missing.name, path: missing.spec.uri } },
        ),
      ],
    };
  }
  return { ok: true, value: record, diagnostics: [] };
}

export function digestTopikAssetSemanticRecord(record: TopikAssetSemanticRecordV1): string {
  return sha256(new TextEncoder().encode(serializeTopikJson(record)));
}

export function digestTopikMaterializationRecord(record: TopikMaterializationRecordV1): string {
  return sha256(new TextEncoder().encode(serializeTopikJson(record)));
}

export function compareTopikAssetIdentities(
  left: { semantic: TopikAssetSemanticRecordV1; materialization: TopikMaterializationRecordV1 },
  right: { semantic: TopikAssetSemanticRecordV1; materialization: TopikMaterializationRecordV1 },
): TopikAssetResult<{ semanticEqual: boolean; exactEqual: boolean }> {
  if (
    left.semantic.descriptor !== right.semantic.descriptor ||
    left.materialization.descriptor !== right.materialization.descriptor
  ) {
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic(
          "TOPIK_ASSET_VERSION_INCOMPARABLE",
          "Identity descriptors differ without an explicit migration",
          { consequence: "block-identity-and-writes", recovery: "revalidate-or-migrate" },
        ),
      ],
    };
  }
  return {
    ok: true,
    value: {
      semanticEqual:
        digestTopikAssetSemanticRecord(left.semantic) ===
        digestTopikAssetSemanticRecord(right.semantic),
      exactEqual:
        digestTopikMaterializationRecord(left.materialization) ===
        digestTopikMaterializationRecord(right.materialization),
    },
    diagnostics: [],
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

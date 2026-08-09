import { createHash } from "node:crypto";
import type { Asset } from "@topik/schema";
import type { Resource } from "../resource";
import { validateResources } from "../validate";
import {
  TOPIK_ASSET_LIMITS,
  TOPIK_ASSET_OUTPUT_PREFIX,
  TOPIK_MATERIALIZATION_VERSION,
} from "./constants";
import {
  topikAssetDiagnostic,
  type TopikAssetDiagnosticId,
  type TopikAssetResult,
} from "./diagnostics";
import { isTopikJsonDataValue, serializeTopikJson } from "./json";
import { validateTopikPathSet } from "./path";

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
  record: unknown,
  resources: readonly Resource[],
): TopikAssetResult<TopikMaterializationRecordV1> {
  if (
    !isTopikJsonDataValue(record) ||
    !isRecord(record) ||
    !Object.hasOwn(record, "descriptor") ||
    typeof record.descriptor !== "string"
  ) {
    return materializationFailure(
      "TOPIK_ASSET_SCHEMA_INVALID",
      "Materialization record is malformed",
    );
  }
  if (record.descriptor !== TOPIK_MATERIALIZATION_VERSION) {
    return materializationFailure(
      "TOPIK_ASSET_UNSUPPORTED_VERSION",
      "Materialization descriptor version is unsupported",
      "topik-materialization-unknown",
    );
  }
  if (!isMaterializationRecordV1(record)) {
    return materializationFailure(
      "TOPIK_ASSET_SCHEMA_INVALID",
      "Materialization record is malformed",
    );
  }
  if (!hasCanonicalMaterializationStructure(record)) {
    return materializationFailure(
      "TOPIK_ASSET_INVENTORY_INCOMPLETE",
      "Materialization inventory records are noncanonical or duplicated",
    );
  }

  if (!validateResources(resources).valid) {
    return materializationFailure(
      "TOPIK_ASSET_INVENTORY_INCOMPLETE",
      "Materialization requires a valid complete compiled resource set",
    );
  }

  const expected = expectedMaterializationRecord(resources);
  if (expected === undefined || serializeTopikJson(record) !== serializeTopikJson(expected)) {
    return materializationFailure(
      "TOPIK_ASSET_INVENTORY_INCOMPLETE",
      "Materialization does not exactly describe the compiled resource set",
    );
  }
  return { ok: true, value: record, diagnostics: [] };
}

function isMaterializationRecordV1(
  value: Record<string, unknown>,
): value is Record<string, unknown> & TopikMaterializationRecordV1 {
  if (
    !hasExactKeys(value, ["descriptor", "payloads", "resources"]) ||
    !Array.isArray(value.resources) ||
    !Array.isArray(value.payloads)
  ) {
    return false;
  }
  return (
    value.resources.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ["path", "resource", "sha256", "size"]) &&
        typeof entry.resource === "string" &&
        typeof entry.path === "string" &&
        validInventorySize(entry.size, TOPIK_ASSET_LIMITS.maxDescriptorBytes) &&
        isSha256(entry.sha256),
    ) &&
    value.payloads.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ["assetNames", "path", "sha256", "size"]) &&
        typeof entry.path === "string" &&
        validInventorySize(entry.size, TOPIK_ASSET_LIMITS.maxAssetBytes) &&
        isSha256(entry.sha256) &&
        Array.isArray(entry.assetNames) &&
        entry.assetNames.every((name) => typeof name === "string"),
    )
  );
}

function hasCanonicalMaterializationStructure(record: TopikMaterializationRecordV1): boolean {
  const resourceKeys = record.resources.map((entry) => entry.resource);
  const resourcePaths = record.resources.map((entry) => entry.path);
  const payloadPaths = record.payloads.map((entry) => entry.path);
  if (
    new Set(resourceKeys).size !== resourceKeys.length ||
    new Set(resourcePaths).size !== resourcePaths.length ||
    new Set(payloadPaths).size !== payloadPaths.length ||
    !isSorted(resourceKeys) ||
    !isSorted(payloadPaths) ||
    record.payloads.some(
      (entry) =>
        new Set(entry.assetNames).size !== entry.assetNames.length || !isSorted(entry.assetNames),
    )
  ) {
    return false;
  }
  const paths = validateTopikPathSet([...resourcePaths, ...payloadPaths]);
  return paths.ok;
}

function expectedMaterializationRecord(
  resources: readonly Resource[],
): TopikMaterializationRecordV1 | undefined {
  let descriptorRecord: TopikMaterializationRecordV1;
  try {
    descriptorRecord = createTopikMaterializationRecord(
      resources.map((resource) => ({
        resource,
        bytes: new TextEncoder().encode(serializeTopikJson(resource)),
      })),
      [],
    );
  } catch {
    return undefined;
  }
  const payloads = new Map<string, TopikMaterializationPayloadV1>();
  for (const resource of resources) {
    if (resource.type !== "Asset" || resource.spec.uri.startsWith("https://")) continue;
    const { integrity, size, uri } = resource.spec;
    if (
      integrity === undefined ||
      size === undefined ||
      size > TOPIK_ASSET_LIMITS.maxAssetBytes ||
      uri !== `${TOPIK_ASSET_OUTPUT_PREFIX}/${integrity.slice("sha256:".length)}`
    ) {
      return undefined;
    }
    const sha256 = integrity.slice("sha256:".length);
    if (!isSha256(sha256)) return undefined;
    const existing = payloads.get(uri);
    if (existing !== undefined) {
      if (existing.sha256 !== sha256 || existing.size !== size) return undefined;
      (existing.assetNames as string[]).push(resource.name);
    } else {
      payloads.set(uri, { path: uri, size, sha256, assetNames: [resource.name] });
    }
  }
  const sortedPayloads = [...payloads.values()]
    .map((payload) => ({ ...payload, assetNames: [...payload.assetNames].sort(compareUtf8) }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const expected = {
    descriptor: TOPIK_MATERIALIZATION_VERSION,
    resources: descriptorRecord.resources,
    payloads: sortedPayloads,
  } satisfies TopikMaterializationRecordV1;
  return hasCanonicalMaterializationStructure(expected) ? expected : undefined;
}

function materializationFailure(
  id: TopikAssetDiagnosticId,
  message: string,
  descriptorVersion: string = TOPIK_MATERIALIZATION_VERSION,
): TopikAssetResult<TopikMaterializationRecordV1> {
  return {
    ok: false,
    diagnostics: [
      topikAssetDiagnostic(id, message, {
        consequence: "block-identity-and-writes",
        descriptorVersion,
        recovery: "revalidate-or-migrate",
      }),
    ],
  };
}

function validInventorySize(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareUtf8(values[index - 1], value) <= 0);
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

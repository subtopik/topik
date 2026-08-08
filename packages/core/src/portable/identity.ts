import { createHash } from "node:crypto";
import type { AssetManifestV1 } from "@topik/schema";
import { ASSET_MANIFEST_SIDECAR_PATH, TOPIK_MATERIALIZATION_VERSION } from "./constants";
import { topikAssetDiagnostic, type TopikAssetResult } from "./diagnostics";
import { parseStrictTopikJson, serializeTopikJson } from "./json";
import { parseAssetManifest } from "./manifest";
import { validateTopikPath, validateTopikPathSet } from "./path";
import { sniffPortableMediaType, type ResolvedTopikAssetOccurrence } from "./snapshot";

export type TopikAssetSemanticOccurrenceV1 =
  | {
      contentPath: string;
      position: string;
      slot: ResolvedTopikAssetOccurrence["slot"];
      role: ResolvedTopikAssetOccurrence["role"];
      kind: "external-https";
      reference: string;
      semantics: ResolvedTopikAssetOccurrence["semantics"];
    }
  | {
      contentPath: string;
      position: string;
      slot: ResolvedTopikAssetOccurrence["slot"];
      role: ResolvedTopikAssetOccurrence["role"];
      kind: "local";
      semantics: ResolvedTopikAssetOccurrence["semantics"];
      key: string;
      path: string;
      digest: AssetManifestV1["assets"][string]["digest"];
      size: number;
      mediaType: string;
      license?: AssetManifestV1["assets"][string]["license"];
      attribution?: AssetManifestV1["assets"][string]["attribution"];
    };

export interface TopikAssetSemanticRecordV1 {
  descriptor: "topik-asset-semantic-v1";
  manifestDescriptors: {
    apiVersion: string;
    pathRules: string;
    referenceRules: string;
    serializer: string;
  };
  resource: AssetManifestV1["resource"];
  occurrences: readonly TopikAssetSemanticOccurrenceV1[];
}

export interface TopikMaterializationDescriptorsV1 {
  resourceApi: string;
  contentApi: string;
  contentSchema: string;
  manifestApi: string;
  pathRules: string;
  referenceRules: string;
  serializer: string;
  materializer: "topik-materialization-v1";
  mapping: string;
  ownershipClassifier: string;
}

export interface TopikMaterializationFileInput {
  path: string;
  type: "regular";
  mode: "100644" | "0644";
  bytes: Uint8Array;
}

export interface TopikMaterializationContextV1 {
  /** Exact owned file that materializes `resource.spec.content.value` as UTF-8. */
  contentPath: string;
}

export interface TopikMaterializationRecordV1 {
  descriptor: "topik-materialization-v1";
  descriptors: TopikMaterializationDescriptorsV1;
  files: readonly {
    path: string;
    type: "regular";
    mode: "100644" | "0644";
    size: number;
    sha256: string;
  }[];
  sidecarBytes: string;
}

export function createTopikAssetSemanticRecord(
  manifest: AssetManifestV1,
  occurrences: readonly ResolvedTopikAssetOccurrence[],
): TopikAssetSemanticRecordV1 {
  const canonicalOccurrences = [...occurrences].sort(compareSemanticOccurrence);
  return {
    descriptor: "topik-asset-semantic-v1",
    manifestDescriptors: {
      apiVersion: manifest.apiVersion,
      pathRules: manifest.pathRules,
      referenceRules: manifest.referenceRules,
      serializer: manifest.serializer,
    },
    resource: { ...manifest.resource },
    occurrences: canonicalOccurrences.map((occurrence): TopikAssetSemanticOccurrenceV1 => {
      if (occurrence.kind === "external-https") {
        return {
          contentPath: occurrence.contentPath,
          position: occurrence.position,
          slot: occurrence.slot,
          role: occurrence.role,
          kind: occurrence.kind,
          reference: occurrence.reference,
          semantics: occurrence.semantics,
        };
      }
      const entry = occurrence.assetKey ? manifest.assets[occurrence.assetKey] : undefined;
      if (occurrence.kind !== "local" || occurrence.assetKey === undefined || entry === undefined) {
        throw new TypeError("Semantic records require a fully resolved validated occurrence set");
      }
      return {
        contentPath: occurrence.contentPath,
        position: occurrence.position,
        slot: occurrence.slot,
        role: occurrence.role,
        kind: "local",
        semantics: occurrence.semantics,
        key: occurrence.assetKey,
        path: entry.path,
        digest: entry.digest,
        size: entry.size,
        mediaType: entry.mediaType,
        ...(entry.license === undefined ? {} : { license: entry.license }),
        ...(entry.attribution === undefined ? {} : { attribution: entry.attribution }),
      };
    }),
  };
}

export function digestTopikAssetSemanticRecord(record: TopikAssetSemanticRecordV1): string {
  return sha256(new TextEncoder().encode(serializeTopikJson(record)));
}

export function createTopikMaterializationRecord(
  descriptors: TopikMaterializationDescriptorsV1,
  files: readonly TopikMaterializationFileInput[],
  context: TopikMaterializationContextV1,
): TopikMaterializationRecordV1 {
  const inventory = new Map<string, TopikMaterializationFileInput>();
  for (const file of files) {
    if (
      file.type !== "regular" ||
      (file.mode !== "100644" && file.mode !== "0644") ||
      !(file.bytes instanceof Uint8Array)
    ) {
      throw new TypeError("Materialization inventory contains an unsupported file type or mode");
    }
    const path = validateTopikPath(file.path, {
      allowControlSidecar: file.path === ASSET_MANIFEST_SIDECAR_PATH,
    });
    if (!path.ok || inventory.has(file.path)) {
      throw new TypeError("Materialization inventory contains an invalid or duplicate path");
    }
    inventory.set(file.path, file);
  }
  const portableInventoryPaths = [...inventory.keys()].filter(
    (path) => path !== ASSET_MANIFEST_SIDECAR_PATH,
  );
  if (!validateTopikPathSet(portableInventoryPaths).ok) {
    throw new TypeError("Materialization inventory contains a portable path collision");
  }
  const sidecar = inventory.get(ASSET_MANIFEST_SIDECAR_PATH);
  if (sidecar === undefined) {
    throw new TypeError("Materialization inventory is missing the canonical sidecar");
  }
  const parsedManifest = parseAssetManifest(sidecar.bytes);
  if (!parsedManifest.ok) {
    throw new TypeError("Materialization requires canonical validated AssetManifest/v1 bytes");
  }
  const manifest = parsedManifest.value.manifest;

  const contentPath = validateTopikPath(context.contentPath);
  if (!contentPath.ok) throw new TypeError("Materialization content path is invalid");
  const expectedPaths = new Set([
    ASSET_MANIFEST_SIDECAR_PATH,
    manifest.resource.path,
    context.contentPath,
    ...Object.values(manifest.assets).map((entry) => entry.path),
  ]);
  if (
    expectedPaths.size !== Object.keys(manifest.assets).length + 3 ||
    inventory.size !== expectedPaths.size ||
    [...expectedPaths].some((path) => !inventory.has(path)) ||
    [...inventory.keys()].some((path) => !expectedPaths.has(path))
  ) {
    throw new TypeError("Materialization inventory is not the complete manifest-owned file set");
  }

  const resourceFile = inventory.get(manifest.resource.path);
  const contentFile = inventory.get(context.contentPath);
  if (resourceFile === undefined || contentFile === undefined) {
    throw new TypeError("Materialization is missing its bound resource or content bytes");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let resource: unknown;
  try {
    const resourceText = decoder.decode(resourceFile.bytes);
    resource = parseStrictTopikJson(resourceText);
    if (serializeTopikJson(resource) !== resourceText) {
      throw new TypeError("Resource descriptor is not canonical topik-json-v1");
    }
  } catch (error) {
    throw new TypeError("Materialization resource descriptor is not canonical JSON", {
      cause: error,
    });
  }
  if (!matchesResourceBinding(resource, manifest.resource)) {
    throw new TypeError("Materialization resource descriptor does not match the manifest binding");
  }
  const embeddedContent = readEmbeddedContent(resource);
  if (
    embeddedContent === undefined ||
    !equalBytes(contentFile.bytes, new TextEncoder().encode(embeddedContent))
  ) {
    throw new TypeError("Materialized content differs from the bound resource descriptor");
  }

  for (const entry of Object.values(manifest.assets)) {
    const file = inventory.get(entry.path);
    if (
      file === undefined ||
      file.bytes.byteLength !== entry.size ||
      sha256(file.bytes) !== entry.digest.value ||
      sniffPortableMediaType(file.bytes) !== entry.mediaType
    ) {
      throw new TypeError("Materialized asset bytes differ from the manifest entry");
    }
  }

  return {
    descriptor: TOPIK_MATERIALIZATION_VERSION,
    descriptors: { ...descriptors },
    files: [...inventory.values()]
      .map((file) => ({
        path: file.path,
        type: file.type,
        mode: file.mode,
        size: file.bytes.byteLength,
        sha256: sha256(file.bytes),
      }))
      .sort((left, right) => compareUtf8(left.path, right.path)),
    sidecarBytes: decoder.decode(sidecar.bytes),
  };
}

export function digestTopikMaterializationRecord(record: TopikMaterializationRecordV1): string {
  return sha256(new TextEncoder().encode(serializeTopikJson(record)));
}

export function compareTopikAssetIdentities(
  left: {
    semantic: TopikAssetSemanticRecordV1;
    materialization: TopikMaterializationRecordV1;
  },
  right: {
    semantic: TopikAssetSemanticRecordV1;
    materialization: TopikMaterializationRecordV1;
  },
): TopikAssetResult<{ semanticEqual: boolean; exactEqual: boolean }> {
  if (
    serializeTopikJson(left.semantic.manifestDescriptors) !==
      serializeTopikJson(right.semantic.manifestDescriptors) ||
    serializeTopikJson(left.materialization.descriptors) !==
      serializeTopikJson(right.materialization.descriptors)
  ) {
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic(
          "TOPIK_ASSET_VERSION_INCOMPARABLE",
          "Identity descriptors differ without a declared migration",
          {
            descriptorVersion: TOPIK_MATERIALIZATION_VERSION,
            consequence: "block-identity-and-writes",
            recovery: "revalidate-or-migrate",
          },
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
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareSemanticOccurrence(
  left: ResolvedTopikAssetOccurrence,
  right: ResolvedTopikAssetOccurrence,
): number {
  return (
    compareUtf8(left.contentPath, right.contentPath) ||
    compareTreePath(left.treePath, right.treePath) ||
    compareUtf8(left.slot, right.slot) ||
    compareUtf8(left.position, right.position)
  );
}

function compareTreePath(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function matchesResourceBinding(value: unknown, binding: AssetManifestV1["resource"]): boolean {
  if (!isRecord(value)) return false;
  return (
    Object.hasOwn(value, "apiVersion") &&
    value.apiVersion === binding.apiVersion &&
    Object.hasOwn(value, "type") &&
    value.type === binding.type &&
    Object.hasOwn(value, "name") &&
    value.name === binding.name
  );
}

function readEmbeddedContent(value: unknown): string | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, "spec") || !isRecord(value.spec)) return undefined;
  if (!Object.hasOwn(value.spec, "content") || !isRecord(value.spec.content)) return undefined;
  if (!Object.hasOwn(value.spec.content, "value")) return undefined;
  return typeof value.spec.content.value === "string" ? value.spec.content.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

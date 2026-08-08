import { createHash } from "node:crypto";
import type { AssetManifestV1 } from "@topik/schema";
import { ASSET_MANIFEST_SIDECAR_PATH, TOPIK_MATERIALIZATION_VERSION } from "./constants";
import { topikAssetDiagnostic, type TopikAssetResult } from "./diagnostics";
import { serializeTopikJson } from "./json";
import { parseAssetManifest } from "./manifest";
import { validateTopikPath } from "./path";
import type { ResolvedTopikAssetOccurrence } from "./snapshot";

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
  sidecarBytes: Uint8Array,
): TopikMaterializationRecordV1 {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const sidecarText = decoder.decode(sidecarBytes);
  if (!parseAssetManifest(sidecarBytes).ok) {
    throw new TypeError("Materialization requires canonical validated AssetManifest/v1 bytes");
  }
  const inventory = new Map<string, TopikMaterializationFileInput>();
  for (const file of files) {
    const path = validateTopikPath(file.path, {
      allowControlSidecar: file.path === ASSET_MANIFEST_SIDECAR_PATH,
    });
    if (!path.ok || inventory.has(file.path)) {
      throw new TypeError("Materialization inventory contains an invalid or duplicate path");
    }
    inventory.set(file.path, file);
  }
  const providedSidecar = inventory.get(ASSET_MANIFEST_SIDECAR_PATH);
  if (providedSidecar && !equalBytes(providedSidecar.bytes, sidecarBytes)) {
    throw new TypeError("Inventoried sidecar bytes differ from the canonical sidecar bytes");
  }
  if (!inventory.has(ASSET_MANIFEST_SIDECAR_PATH)) {
    inventory.set(ASSET_MANIFEST_SIDECAR_PATH, {
      path: ASSET_MANIFEST_SIDECAR_PATH,
      type: "regular",
      mode: "100644",
      bytes: sidecarBytes,
    });
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
    sidecarBytes: sidecarText,
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

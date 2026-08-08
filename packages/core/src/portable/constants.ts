export const ASSET_MANIFEST_API_VERSION = "v1" as const;
export const ASSET_MANIFEST_TYPE = "AssetManifest" as const;
export const ASSET_MANIFEST_SCHEMA_ID = "https://topik.dev/schemas/asset-manifest/v1.json" as const;
export const ASSET_MANIFEST_SIDECAR_PATH = ".topik/assets.json" as const;
export const TOPIK_JSON_VERSION = "topik-json-v1" as const;
export const TOPIK_PATH_VERSION = "topik-path-v1" as const;
export const TOPIK_ASSET_REFERENCE_VERSION = "topik-asset-reference-v1" as const;
export const TOPIK_MATERIALIZATION_VERSION = "topik-materialization-v1" as const;

export const TOPIK_PATH_V1_DESCRIPTOR = {
  collisionNormalization: "toNFKC_Casefold",
  id: TOPIK_PATH_VERSION,
  localReferenceEncoding: "rfc3986-utf8-upper-v1",
  maxComponentUtf8Bytes: 255,
  maxComponents: 64,
  maxRepositoryPathUtf8Bytes: 768,
  storageNormalization: "NFC",
  unicodeVersion: "17.0.0",
} as const;

export const TOPIK_ASSET_PORTABLE_LIMITS = {
  maxManifestBytes: 16_777_216,
  maxAssets: 10_000,
  maxJsonDepth: 8,
  maxComponentUtf8Bytes: 255,
  maxComponents: 64,
  maxRepositoryPathUtf8Bytes: 768,
} as const;

export interface TopikAssetConsumerCapabilities {
  manifestApiVersions: readonly ["v1", ...string[]] | readonly string[];
  serializerVersions: readonly ["topik-json-v1", ...string[]] | readonly string[];
  pathRuleVersions: readonly ["topik-path-v1", ...string[]] | readonly string[];
  referenceRuleVersions: readonly ["topik-asset-reference-v1", ...string[]] | readonly string[];
  maxManifestBytes: number;
  maxAssets: number;
  maxJsonDepth: number;
  maxComponentUtf8Bytes: number;
  maxComponents: number;
  maxRepositoryPathUtf8Bytes: number;
}

export const TOPIK_ASSET_DEFAULT_CAPABILITIES: TopikAssetConsumerCapabilities = {
  manifestApiVersions: [ASSET_MANIFEST_API_VERSION],
  serializerVersions: [TOPIK_JSON_VERSION],
  pathRuleVersions: [TOPIK_PATH_VERSION],
  referenceRuleVersions: [TOPIK_ASSET_REFERENCE_VERSION],
  ...TOPIK_ASSET_PORTABLE_LIMITS,
};

export function declareTopikAssetConsumerCapabilities(
  limits: Partial<TopikAssetConsumerCapabilities> = {},
): TopikAssetConsumerCapabilities {
  const declared = { ...TOPIK_ASSET_DEFAULT_CAPABILITIES, ...limits };
  return {
    ...declared,
    maxManifestBytes: bounded(
      declared.maxManifestBytes,
      TOPIK_ASSET_PORTABLE_LIMITS.maxManifestBytes,
    ),
    maxAssets: bounded(declared.maxAssets, TOPIK_ASSET_PORTABLE_LIMITS.maxAssets),
    maxJsonDepth: bounded(declared.maxJsonDepth, TOPIK_ASSET_PORTABLE_LIMITS.maxJsonDepth),
    maxComponentUtf8Bytes: bounded(
      declared.maxComponentUtf8Bytes,
      TOPIK_ASSET_PORTABLE_LIMITS.maxComponentUtf8Bytes,
    ),
    maxComponents: bounded(declared.maxComponents, TOPIK_ASSET_PORTABLE_LIMITS.maxComponents),
    maxRepositoryPathUtf8Bytes: bounded(
      declared.maxRepositoryPathUtf8Bytes,
      TOPIK_ASSET_PORTABLE_LIMITS.maxRepositoryPathUtf8Bytes,
    ),
  };
}

function bounded(value: number, portableMaximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > portableMaximum) {
    throw new RangeError(`Capability limit must be an integer from 1 through ${portableMaximum}`);
  }
  return value;
}

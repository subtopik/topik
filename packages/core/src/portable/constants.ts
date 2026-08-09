export const ASSET_API_VERSION = "v1" as const;
export const ASSET_TYPE = "Asset" as const;
export const ASSET_SCHEMA_ID = "https://topik.dev/schemas/asset/v1.json" as const;
export const TOPIK_JSON_VERSION = "topik-json-v1" as const;
export const TOPIK_PATH_VERSION = "topik-path-v1" as const;
export const TOPIK_ASSET_REFERENCE_VERSION = "topik-asset-reference-v1" as const;
export const TOPIK_MATERIALIZATION_VERSION = "topik-materialization-v1" as const;
export const TOPIK_ASSET_NAME_VERSION = "topik-asset-name-v1" as const;
export const TOPIK_ASSET_OUTPUT_PREFIX = "assets/sha256" as const;

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

export const TOPIK_ASSET_LIMITS = {
  maxDescriptorBytes: 1_048_576,
  maxAssetBytes: 268_435_456,
  maxAssets: 10_000,
  maxJsonDepth: 8,
  maxComponentUtf8Bytes: 255,
  maxComponents: 64,
  maxRepositoryPathUtf8Bytes: 768,
} as const;

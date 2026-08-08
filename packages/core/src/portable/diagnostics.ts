export const TOPIK_ASSET_DIAGNOSTIC_IDS = [
  "TOPIK_ASSET_MANIFEST_UNSUPPORTED_VERSION",
  "TOPIK_ASSET_MANIFEST_UNSUPPORTED_SERIALIZER",
  "TOPIK_ASSET_MANIFEST_UNSUPPORTED_PATH_RULES",
  "TOPIK_ASSET_MANIFEST_UNSUPPORTED_REFERENCE_RULES",
  "TOPIK_ASSET_MANIFEST_DUPLICATE_MEMBER",
  "TOPIK_ASSET_MANIFEST_SCHEMA_INVALID",
  "TOPIK_ASSET_MANIFEST_NON_CANONICAL",
  "TOPIK_ASSET_RESOURCE_MISMATCH",
  "TOPIK_ASSET_KEY_INVALID",
  "TOPIK_ASSET_PATH_INVALID",
  "TOPIK_ASSET_PATH_COLLISION",
  "TOPIK_ASSET_REFERENCE_AMBIGUOUS",
  "TOPIK_ASSET_MANIFEST_INCOMPLETE",
  "TOPIK_ASSET_ENTRY_UNREFERENCED",
  "TOPIK_ASSET_FILE_MISSING",
  "TOPIK_ASSET_DIGEST_MISMATCH",
  "TOPIK_ASSET_SIZE_MISMATCH",
  "TOPIK_ASSET_MEDIA_TYPE_MISMATCH",
  "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED",
  "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED",
  "TOPIK_ASSET_REFERENCE_ACCESSIBILITY_INVALID",
  "TOPIK_EXTERNAL_REFERENCE_UNSAFE",
  "TOPIK_ASSET_OWNERSHIP_UNPROVEN",
  "TOPIK_ASSET_SHARED_SIDECAR_UNSUPPORTED",
  "TOPIK_ASSET_VERSION_INCOMPARABLE",
  "TOPIK_LEGACY_ASSET_REFERENCE_UNRESOLVED",
  "TOPIK_LEGACY_ASSET_REFERENCE_AMBIGUOUS",
] as const;

export const TOPIK_ASSET_DEFAULT_CORRELATION_ID = "cor_00000000000000000000000000" as const;
export const TOPIK_ASSET_CORRELATION_ID_PATTERN = /^cor_[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
export type TopikAssetCorrelationId = `cor_${string}`;

export type TopikAssetDiagnosticId = (typeof TOPIK_ASSET_DIAGNOSTIC_IDS)[number];

export type TopikAssetPathDiagnosticReason =
  | "invalid_utf8"
  | "capability_invalid"
  | "unicode_version_unsupported"
  | "not_nfc"
  | "absolute"
  | "separator_alias"
  | "dot_segment"
  | "percent_noncanonical"
  | "forbidden_character"
  | "reserved_name"
  | "too_long"
  | "casefold_collision";

export type TopikAssetRecoveryCategory =
  | "upgrade-reader"
  | "repair-source"
  | "canonicalize-explicitly"
  | "restore-file"
  | "verify-bytes"
  | "choose-explicit-mapping"
  | "establish-baseline"
  | "revalidate-or-migrate"
  | "preserve-read-only";

export interface TopikAssetDiagnosticLocation {
  jsonPointer?: string;
  contentPosition?: string;
  path?: string;
  key?: string;
  commit?: string;
}

export interface TopikAssetDiagnostic {
  id: TopikAssetDiagnosticId;
  /** Safe opaque operation correlation; callers may replace the deterministic default. */
  correlationId: TopikAssetCorrelationId;
  severity: "error";
  consequence: "block-resource" | "block-identity-and-writes" | "block-mutation";
  descriptorVersion: string;
  location: TopikAssetDiagnosticLocation;
  recovery: TopikAssetRecoveryCategory;
  reason?: TopikAssetPathDiagnosticReason;
  /** Human wording is intentionally not a stable compatibility surface. */
  message: string;
}

export type TopikAssetResult<T> =
  | { ok: true; value: T; diagnostics: readonly []; source?: Uint8Array }
  | {
      ok: false;
      value?: T;
      diagnostics: readonly TopikAssetDiagnostic[];
      source?: Uint8Array;
    };

export function topikAssetDiagnostic(
  id: TopikAssetDiagnosticId,
  message: string,
  options: Partial<Omit<TopikAssetDiagnostic, "id" | "message" | "severity">> = {},
): TopikAssetDiagnostic {
  return {
    id,
    correlationId: options.correlationId ?? TOPIK_ASSET_DEFAULT_CORRELATION_ID,
    severity: "error",
    consequence: options.consequence ?? "block-resource",
    descriptorVersion: options.descriptorVersion ?? "AssetManifest/v1",
    location: options.location ?? {},
    recovery: options.recovery ?? "repair-source",
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    message,
  };
}

export function correlateTopikAssetResult<T>(
  result: TopikAssetResult<T>,
  correlationId: TopikAssetCorrelationId,
): TopikAssetResult<T> {
  if (!TOPIK_ASSET_CORRELATION_ID_PATTERN.test(correlationId)) {
    throw new RangeError("Correlation ID must be opaque 128-bit lowercase Crockford form");
  }
  if (result.ok) return result;
  return {
    ...result,
    diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic, correlationId })),
  };
}

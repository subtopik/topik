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
      /** Exact caller bytes are non-loggable evidence; never copy them into diagnostics/telemetry. */
      source?: Uint8Array;
    };

export function topikAssetDiagnostic(
  id: TopikAssetDiagnosticId,
  message: string,
  options: Partial<Omit<TopikAssetDiagnostic, "id" | "message" | "severity">> = {},
): TopikAssetDiagnostic {
  const location = options.location ?? {};
  return {
    id,
    correlationId: options.correlationId ?? TOPIK_ASSET_DEFAULT_CORRELATION_ID,
    severity: "error",
    consequence: options.consequence ?? "block-resource",
    descriptorVersion: sanitizeDescriptorVersion(options.descriptorVersion ?? "AssetManifest/v1"),
    location: {
      ...(location.jsonPointer === undefined
        ? {}
        : { jsonPointer: sanitizeJsonPointer(location.jsonPointer) }),
      ...(location.contentPosition === undefined
        ? {}
        : { contentPosition: sanitizeAsciiField(location.contentPosition, "[redacted]") }),
      ...(location.path === undefined ? {} : { path: sanitizePath(location.path) }),
      ...(location.key === undefined ? {} : { key: sanitizeKey(location.key) }),
      ...(location.commit === undefined ? {} : { commit: sanitizeCommit(location.commit) }),
    },
    recovery: options.recovery ?? "repair-source",
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    message: sanitizeMessage(message),
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

/** Internal composition helper that preserves sanitization when adding location context. */
export function relocateTopikAssetDiagnostic(
  diagnostic: TopikAssetDiagnostic,
  location: TopikAssetDiagnosticLocation,
): TopikAssetDiagnostic {
  return topikAssetDiagnostic(diagnostic.id, diagnostic.message, {
    correlationId: diagnostic.correlationId,
    consequence: diagnostic.consequence,
    descriptorVersion: diagnostic.descriptorVersion,
    location,
    recovery: diagnostic.recovery,
    ...(diagnostic.reason === undefined ? {} : { reason: diagnostic.reason }),
  });
}

const UNSAFE_DIAGNOSTIC_UNICODE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Noncharacter_Code_Point}]/u;
const UNSAFE_DIAGNOSTIC_WHITESPACE = /[\p{White_Space}&&[^ ]]/v;
const SAFE_ASCII_FIELD = /^[\x20-\x7e]{1,1024}$/u;

function sanitizeMessage(value: string): string {
  return SAFE_ASCII_FIELD.test(value) ? value : "Diagnostic detail was redacted";
}

function sanitizeAsciiField(value: string, replacement: string): string {
  return SAFE_ASCII_FIELD.test(value) ? value : replacement;
}

function sanitizeDescriptorVersion(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9./_-]{0,127}$/u.test(value) ? value : "unknown-descriptor";
}

function sanitizeKey(value: string): string {
  return /^(?:ast_[0-7][0-9a-hjkmnp-tv-z]{25}|[0-9a-f]{16})$/u.test(value) ? value : "[redacted]";
}

function sanitizeCommit(value: string): string {
  return /^[0-9a-f]{7,64}$/u.test(value) ? value : "[redacted]";
}

function sanitizeJsonPointer(value: string): string {
  if (!value.startsWith("/")) return "/[redacted]";
  const segments = value.slice(1).split("/");
  return segments.every(isSafeJsonPointerSegment) ? value : "/[redacted]";
}

function isSafeJsonPointerSegment(value: string): boolean {
  return (
    value.length === 0 ||
    /^(?:[0-9]+|ast_[0-7][0-9a-hjkmnp-tv-z]{25})$/u.test(value) ||
    [
      "algorithm",
      "apiVersion",
      "assets",
      "attribution",
      "creator",
      "digest",
      "license",
      "mediaType",
      "name",
      "path",
      "pathRules",
      "referenceRules",
      "resource",
      "serializer",
      "size",
      "sourceUrl",
      "spdxExpression",
      "text",
      "title",
      "type",
      "url",
      "value",
    ].includes(value)
  );
}

function sanitizePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    UNSAFE_DIAGNOSTIC_UNICODE.test(value) ||
    UNSAFE_DIAGNOSTIC_WHITESPACE.test(value) ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(value) ||
    value.startsWith("//")
  ) {
    return "[redacted]";
  }
  return value;
}

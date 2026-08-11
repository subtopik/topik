import {
  isTopikPathCodePointForbiddenV17,
  isTopikPathNormalizationSensitiveV17,
} from "./path-unicode-v17";

export const TOPIK_ASSET_DIAGNOSTIC_IDS = [
  "TOPIK_ASSET_UNSUPPORTED_VERSION",
  "TOPIK_ASSET_DUPLICATE_MEMBER",
  "TOPIK_ASSET_SCHEMA_INVALID",
  "TOPIK_ASSET_NON_CANONICAL",
  "TOPIK_ASSET_NAME_INVALID",
  "TOPIK_ASSET_NAME_COLLISION",
  "TOPIK_ASSET_SOURCE_NAMESPACE_REQUIRED",
  "TOPIK_ASSET_SOURCE_NAMESPACE_INVALID",
  "TOPIK_ASSET_PATH_INVALID",
  "TOPIK_ASSET_PATH_COLLISION",
  "TOPIK_ASSET_REFERENCE_AMBIGUOUS",
  "TOPIK_ASSET_REFERENCE_MALFORMED",
  "TOPIK_ASSET_REFERENCE_MISSING",
  "TOPIK_ASSET_FILE_MISSING",
  "TOPIK_ASSET_DIGEST_MISMATCH",
  "TOPIK_ASSET_SIZE_MISMATCH",
  "TOPIK_ASSET_MEDIA_TYPE_MISMATCH",
  "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED",
  "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED",
  "TOPIK_ASSET_REFERENCE_ACCESSIBILITY_INVALID",
  "TOPIK_EXTERNAL_REFERENCE_UNSAFE",
  "TOPIK_ASSET_INVENTORY_INCOMPLETE",
  "TOPIK_ASSET_VERSION_INCOMPARABLE",
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
  | "restore-file"
  | "verify-bytes"
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
    descriptorVersion: sanitizeDescriptorVersion(options.descriptorVersion ?? "Asset/v1"),
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
  return /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|auto-v1-[a-z2-7]{51}[aq])$/u.test(value)
    ? value
    : "[redacted]";
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
    /^(?:[0-9]+|[a-z0-9]+(?:-[a-z0-9]+)*|auto-v1-[a-z2-7]{51}[aq])$/u.test(value) ||
    [
      "algorithm",
      "apiVersion",
      "attribution",
      "creator",
      "integrity",
      "license",
      "mediaType",
      "name",
      "spec",
      "uri",
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
  const components = value.split("/");
  if (
    value.length === 0 ||
    value.length > 1024 ||
    containsUnsafeDiagnosticUnicode(value) ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes(":") ||
    value.includes("%") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(value) ||
    value.startsWith("//") ||
    components.some((component) => component === "." || component === "..") ||
    /[／∕⁄⧸＼⧵：꞉]/u.test(value)
  ) {
    return "[redacted]";
  }
  return value;
}

function containsUnsafeDiagnosticUnicode(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      isTopikPathCodePointForbiddenV17(codePoint) ||
      isTopikPathNormalizationSensitiveV17(codePoint)
    ) {
      return true;
    }
  }
  return false;
}

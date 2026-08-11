import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import {
  assetV1Schema,
  hasMatchingAssetDigests,
  isGeneratedAssetName as isSchemaGeneratedAssetName,
  parseGeneratedAssetName,
  type Asset,
  type GeneratedAssetName,
} from "@topik/schema";
import {
  ASSET_API_VERSION,
  ASSET_TYPE,
  TOPIK_ASSET_LIMITS,
  TOPIK_ASSET_NAME_VERSION,
} from "./constants";
import {
  topikAssetDiagnostic,
  type TopikAssetDiagnostic,
  type TopikAssetResult,
} from "./diagnostics";
import {
  isTopikJsonDataValue,
  parseStrictTopikJson,
  serializeTopikJson,
  TopikJsonSyntaxError,
} from "./json";
import { validateTopikPath } from "./path";
import {
  isTopikPathCodePointForbiddenV17,
  isTopikPathNormalizationSensitiveV17,
} from "./path-unicode-v17";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  allErrors: true,
  ownProperties: true,
});
const validateSchema = ajv.compile(assetV1Schema);

export interface ParsedAsset {
  asset: Asset;
  canonicalBytes: Uint8Array;
}

export function parseAsset(input: string | Uint8Array): TopikAssetResult<ParsedAsset> {
  const source = typeof input === "string" ? encoder.encode(input) : Uint8Array.from(input);
  if (source.byteLength > TOPIK_ASSET_LIMITS.maxDescriptorBytes) {
    return fail(source, "TOPIK_ASSET_SCHEMA_INVALID", "Asset descriptor exceeds the byte limit");
  }
  let text: string;
  try {
    text = decoder.decode(source);
  } catch {
    return fail(source, "TOPIK_ASSET_SCHEMA_INVALID", "Asset descriptor is not strict UTF-8");
  }
  if (text.startsWith("\ufeff")) {
    return fail(source, "TOPIK_ASSET_SCHEMA_INVALID", "Asset descriptor must not contain a BOM");
  }

  let value: unknown;
  try {
    value = parseStrictTopikJson(text, TOPIK_ASSET_LIMITS.maxJsonDepth);
  } catch (error) {
    const duplicate = error instanceof TopikJsonSyntaxError && error.duplicatePointer !== undefined;
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic(
          duplicate ? "TOPIK_ASSET_DUPLICATE_MEMBER" : "TOPIK_ASSET_SCHEMA_INVALID",
          error instanceof Error ? error.message : "Asset descriptor is not strict JSON",
          {
            location: {
              jsonPointer:
                error instanceof TopikJsonSyntaxError ? (error.duplicatePointer ?? "/") : "/",
            },
          },
        ),
      ],
      source,
    };
  }

  const validated = validateAssetValue(value);
  if (!validated.ok) return { ok: false, diagnostics: validated.diagnostics, source };
  const canonicalText = serializeTopikJson(validated.value);
  const canonicalBytes = encoder.encode(canonicalText);
  if (!equalBytes(source, canonicalBytes)) {
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic("TOPIK_ASSET_NON_CANONICAL", "Asset bytes are not canonical JSON", {
          location: { jsonPointer: "/" },
          recovery: "repair-source",
          consequence: "block-identity-and-writes",
        }),
      ],
      source,
    };
  }
  return { ok: true, value: { asset: validated.value, canonicalBytes }, diagnostics: [], source };
}

export function validateAssetValue(value: unknown): TopikAssetResult<Asset> {
  if (!isTopikJsonDataValue(value)) {
    return failure(
      "TOPIK_ASSET_SCHEMA_INVALID",
      "Asset must contain only own JSON data properties",
    );
  }
  if (isRecord(value)) {
    const type = Object.hasOwn(value, "type") ? value.type : undefined;
    const apiVersion = Object.hasOwn(value, "apiVersion") ? value.apiVersion : undefined;
    if (type === ASSET_TYPE && apiVersion !== ASSET_API_VERSION) {
      return failure(
        "TOPIK_ASSET_UNSUPPORTED_VERSION",
        "Unsupported Asset apiVersion",
        "/apiVersion",
      );
    }
    const spec = Object.hasOwn(value, "spec") && isRecord(value.spec) ? value.spec : undefined;
    if (
      spec !== undefined &&
      Object.hasOwn(spec, "size") &&
      typeof spec.size === "number" &&
      spec.size > TOPIK_ASSET_LIMITS.maxAssetBytes
    ) {
      return failure(
        "TOPIK_ASSET_SIZE_MISMATCH",
        "Asset size exceeds the portable byte limit",
        "/spec/size",
      );
    }
  }
  if (!validateSchema(value)) {
    return { ok: false, diagnostics: (validateSchema.errors ?? []).map(schemaDiagnostic) };
  }
  const asset = value as unknown as Asset;
  const uri = validateAssetUri(asset.spec.uri);
  if (!uri.ok) return { ok: false, diagnostics: uri.diagnostics };
  if (!hasMatchingAssetDigests(asset)) {
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic(
          "TOPIK_ASSET_DIGEST_MISMATCH",
          "Asset payload URI and integrity must identify the same digest",
          {
            consequence: "block-identity-and-writes",
            location: { jsonPointer: "/spec/integrity" },
            recovery: "verify-bytes",
          },
        ),
      ],
    };
  }
  return { ok: true, value: asset, diagnostics: [] };
}

/** Serialize one Asset to deterministic UTF-8 canonical JSON and prove its round trip. */
export function serializeAsset(value: unknown): TopikAssetResult<Uint8Array> {
  const validation = validateAssetValue(value);
  if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };
  const bytes = encoder.encode(serializeTopikJson(validation.value));
  const parsed = parseAsset(bytes);
  if (
    !parsed.ok ||
    serializeTopikJson(parsed.value.asset) !== serializeTopikJson(validation.value)
  ) {
    return failure("TOPIK_ASSET_NON_CANONICAL", "Serialized Asset failed strict semantic reparse");
  }
  return { ok: true, value: bytes, diagnostics: [] };
}

export function validateAssetUri(
  value: string,
): TopikAssetResult<{ uri: `assets/sha256/${string}` }> {
  const local = validateTopikPath(value);
  if (!local.ok) return { ok: false, diagnostics: local.diagnostics };
  if (!/^assets\/sha256\/[0-9a-f]{64}$/u.test(local.value.path)) {
    return failure(
      "TOPIK_ASSET_SCHEMA_INVALID",
      "Asset URI must identify a compiler-materialized payload",
      "/spec/uri",
    );
  }
  return {
    ok: true,
    value: { uri: local.value.path as `assets/sha256/${string}` },
    diagnostics: [],
  };
}

export function isGeneratedAssetName(value: string): value is GeneratedAssetName {
  return isSchemaGeneratedAssetName(value);
}

export function validateStableSourceNamespace(value: string): TopikAssetResult<string> {
  if (containsForbiddenPortableText(value)) {
    return failure(
      "TOPIK_ASSET_SOURCE_NAMESPACE_INVALID",
      "Stable source namespace is not portable text after NFC normalization",
    );
  }
  const normalized = value.normalize("NFC");
  const bytes = encoder.encode(normalized);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > 1024 ||
    containsForbiddenPortableText(normalized)
  ) {
    return failure(
      "TOPIK_ASSET_SOURCE_NAMESPACE_INVALID",
      "Stable source namespace is not portable text after NFC normalization",
    );
  }
  return { ok: true, value: normalized, diagnostics: [] };
}

function containsForbiddenPortableText(value: string): boolean {
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

export interface GenerateAutomaticAssetNameOptions {
  stableSourceNamespace: string;
  normalizedPath: string;
}

export function generateAutomaticAssetName(
  options: GenerateAutomaticAssetNameOptions,
): TopikAssetResult<GeneratedAssetName> {
  const namespace = validateStableSourceNamespace(options.stableSourceNamespace);
  if (!namespace.ok) return { ok: false, diagnostics: namespace.diagnostics };
  const path = validateTopikPath(options.normalizedPath);
  if (!path.ok) return { ok: false, diagnostics: path.diagnostics };
  const input = new Uint8Array(
    encoder.encode(namespace.value).byteLength + 1 + encoder.encode(path.value.path).byteLength,
  );
  const namespaceBytes = encoder.encode(namespace.value);
  const pathBytes = encoder.encode(path.value.path);
  input.set(namespaceBytes, 0);
  input[namespaceBytes.byteLength] = 0;
  input.set(pathBytes, namespaceBytes.byteLength + 1);
  const digest = createHash("sha256").update(input).digest();
  return {
    ok: true,
    value: parseGeneratedAssetName(`auto-v1-${base32(digest)}`),
    diagnostics: [],
  };
}

export function topikAssetNameDescriptor(): { id: typeof TOPIK_ASSET_NAME_VERSION } {
  return { id: TOPIK_ASSET_NAME_VERSION };
}

function schemaDiagnostic(error: ErrorObject): TopikAssetDiagnostic {
  return topikAssetDiagnostic("TOPIK_ASSET_SCHEMA_INVALID", "Asset does not match Asset/v1", {
    location: { jsonPointer: error.instancePath || "/" },
  });
}

function failure<T>(
  id: Parameters<typeof topikAssetDiagnostic>[0],
  message: string,
  jsonPointer = "/",
): TopikAssetResult<T> {
  return {
    ok: false,
    diagnostics: [topikAssetDiagnostic(id, message, { location: { jsonPointer } })],
  };
}

function fail<T>(
  source: Uint8Array,
  id: Parameters<typeof topikAssetDiagnostic>[0],
  message: string,
): TopikAssetResult<T> {
  return { ...failure<T>(id, message), source };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let accumulator = 0;
  let bits = 0;
  let result = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { assetV1Schema, type Asset } from "@topik/schema";
import spdxExpressionParse from "spdx-expression-parse";
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

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const GENERATED_NAME = /^auto-v1-[a-z2-7]{52}$/u;
const EXPLICIT_NAME = /^(?!auto-v1-)[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FORBIDDEN_TEXT =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Noncharacter_Code_Point}]/u;

const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  allErrors: true,
  ownProperties: true,
});
ajv.addFormat("topik-asset-uri-v1", {
  type: "string",
  validate: (value: string) => validateAssetUri(value).ok,
});
ajv.addFormat("topik-plain-text-v1", { type: "string", validate: validateTopikPlainText });
ajv.addFormat("topik-https-url-v1", { type: "string", validate: validatePortableHttpsUri });
ajv.addFormat("spdx-expression-2.3", { type: "string", validate: validateSpdxExpression });
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
          recovery: "canonicalize-explicitly",
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
  }
  if (!validateSchema(value)) {
    return { ok: false, diagnostics: (validateSchema.errors ?? []).map(schemaDiagnostic) };
  }
  const asset = value as unknown as Asset;
  const uri = validateAssetUri(asset.spec.uri);
  if (!uri.ok) return { ok: false, diagnostics: uri.diagnostics };
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
): TopikAssetResult<{ kind: "local" | "remote"; uri: string }> {
  if (value.startsWith("https://")) {
    if (!validatePortableHttpsUri(value)) {
      return failure(
        "TOPIK_EXTERNAL_REFERENCE_UNSAFE",
        "Remote Asset URI is not immutable and credential-free",
        "/spec/uri",
      );
    }
    return { ok: true, value: { kind: "remote", uri: value }, diagnostics: [] };
  }
  const local = validateTopikPath(value);
  if (!local.ok) return { ok: false, diagnostics: local.diagnostics };
  return { ok: true, value: { kind: "local", uri: local.value.path }, diagnostics: [] };
}

export function isGeneratedAssetName(value: string): boolean {
  return GENERATED_NAME.test(value);
}

export function isExplicitAssetName(value: string): boolean {
  return value.length <= 63 && EXPLICIT_NAME.test(value);
}

export function validateStableSourceNamespace(value: string): TopikAssetResult<string> {
  const normalized = value.normalize("NFC");
  const bytes = encoder.encode(normalized);
  if (bytes.byteLength < 1 || bytes.byteLength > 1024 || FORBIDDEN_TEXT.test(normalized)) {
    return failure(
      "TOPIK_ASSET_SOURCE_NAMESPACE_INVALID",
      "Stable source namespace is not portable text after NFC normalization",
    );
  }
  return { ok: true, value: normalized, diagnostics: [] };
}

export interface GenerateImplicitAssetNameOptions {
  stableSourceNamespace: string;
  normalizedPath: string;
  /** Deterministic collision seam. Production callers omit it. */
  hash?: (bytes: Uint8Array) => Uint8Array;
}

export function generateImplicitAssetName(
  options: GenerateImplicitAssetNameOptions,
): TopikAssetResult<string> {
  const namespace = validateStableSourceNamespace(options.stableSourceNamespace);
  if (!namespace.ok) return namespace;
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
  const digest = options.hash?.(input) ?? createHash("sha256").update(input).digest();
  if (digest.byteLength !== 32)
    throw new TypeError("Implicit Asset name hash must return 32 bytes");
  return {
    ok: true,
    value: `auto-v1-${base32(digest)}`,
    diagnostics: [],
  };
}

export function topikAssetNameDescriptor(): { id: typeof TOPIK_ASSET_NAME_VERSION } {
  return { id: TOPIK_ASSET_NAME_VERSION };
}

function validatePortableHttpsUri(value: string): boolean {
  if (
    FORBIDDEN_TEXT.test(value) ||
    /(?:x-amz-|x-goog-|signature|signed|token|expires)/iu.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname.length > 0 &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

function validateTopikPlainText(value: string): boolean {
  return value.normalize("NFC") === value && !FORBIDDEN_TEXT.test(value) && value.trim() === value;
}

function validateSpdxExpression(value: string): boolean {
  try {
    return spdxExpressionParse(value) !== null;
  } catch {
    return false;
  }
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

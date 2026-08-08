import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { assetManifestV1Schema, type AssetManifestV1 } from "@topik/schema";
import spdxExpressionParse from "spdx-expression-parse";
import {
  ASSET_MANIFEST_API_VERSION,
  ASSET_MANIFEST_TYPE,
  TOPIK_ASSET_DEFAULT_CAPABILITIES,
  TOPIK_ASSET_PORTABLE_LIMITS,
  TOPIK_ASSET_REFERENCE_VERSION,
  TOPIK_JSON_VERSION,
  TOPIK_PATH_VERSION,
  type TopikAssetConsumerCapabilities,
} from "./constants";
import {
  relocateTopikAssetDiagnostic,
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
import { isTopikAssetKey } from "./key";
import { validateTopikPath, validateTopikPathSet } from "./path";
import { validateTopikExternalAssetReference } from "./reference";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_TEXT =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Noncharacter_Code_Point}]/u;

const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  allErrors: true,
  ownProperties: true,
});
ajv.addFormat("topik-path-v1", {
  type: "string",
  validate: (value: string) => validateTopikPath(value).ok,
});
ajv.addFormat("topik-plain-text-v1", {
  type: "string",
  validate: validateTopikPlainText,
});
ajv.addFormat("topik-https-url-v1", {
  type: "string",
  validate: (value: string) => validateTopikExternalAssetReference(value).ok,
});
ajv.addFormat("spdx-expression-2.3", {
  type: "string",
  validate: validateSpdxExpression,
});
const validateSchema = ajv.compile(assetManifestV1Schema);

export interface ParseAssetManifestOptions {
  capabilities?: TopikAssetConsumerCapabilities;
  /** Repository-relative binding root used for the complete 768-byte path limit. */
  bindingRoot?: string;
}

export interface AssetManifestValidationContext {
  /** Repository-relative binding root used for the complete 768-byte path limit. */
  bindingRoot?: string;
}

export interface ParsedAssetManifest {
  manifest: AssetManifestV1;
  canonicalBytes: Uint8Array;
}

export function parseAssetManifest(
  input: string | Uint8Array,
  options: ParseAssetManifestOptions = {},
): TopikAssetResult<ParsedAssetManifest> {
  const source = typeof input === "string" ? encoder.encode(input) : Uint8Array.from(input);
  const capabilities = options.capabilities ?? TOPIK_ASSET_DEFAULT_CAPABILITIES;
  const capabilityProblem = validateCapabilities(capabilities);
  if (capabilityProblem !== undefined) return failure(source, capabilityProblem);
  if (
    source.byteLength > TOPIK_ASSET_PORTABLE_LIMITS.maxManifestBytes ||
    source.byteLength > capabilities.maxManifestBytes
  ) {
    return failure(
      source,
      topikAssetDiagnostic(
        "TOPIK_ASSET_MANIFEST_SCHEMA_INVALID",
        "Manifest exceeds the advertised raw-byte limit",
        { location: { jsonPointer: "/" } },
      ),
    );
  }

  let text: string;
  try {
    text = decoder.decode(source);
  } catch {
    return failure(
      source,
      topikAssetDiagnostic("TOPIK_ASSET_MANIFEST_SCHEMA_INVALID", "Manifest is not strict UTF-8", {
        location: { jsonPointer: "/" },
      }),
    );
  }
  if (text.startsWith("\ufeff")) {
    return failure(
      source,
      topikAssetDiagnostic(
        "TOPIK_ASSET_MANIFEST_SCHEMA_INVALID",
        "Manifest must not contain a BOM",
        {
          location: { jsonPointer: "/" },
        },
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = parseStrictTopikJson(
      text,
      Math.min(TOPIK_ASSET_PORTABLE_LIMITS.maxJsonDepth, capabilities.maxJsonDepth),
    );
  } catch (error) {
    const duplicate = error instanceof TopikJsonSyntaxError && error.duplicatePointer !== undefined;
    return failure(
      source,
      topikAssetDiagnostic(
        duplicate ? "TOPIK_ASSET_MANIFEST_DUPLICATE_MEMBER" : "TOPIK_ASSET_MANIFEST_SCHEMA_INVALID",
        error instanceof Error ? error.message : "Manifest is not strict JSON",
        {
          descriptorVersion: TOPIK_JSON_VERSION,
          location: {
            jsonPointer:
              error instanceof TopikJsonSyntaxError ? (error.duplicatePointer ?? "/") : "/",
          },
        },
      ),
    );
  }

  const descriptorDiagnostic = validateDescriptors(parsed, capabilities);
  if (descriptorDiagnostic !== undefined) return failure(source, descriptorDiagnostic);

  const validation = validateAssetManifestValue(parsed, capabilities, {
    bindingRoot: options.bindingRoot,
  });
  if (!validation.ok) {
    return { ok: false, diagnostics: validation.diagnostics, source };
  }

  const canonicalText = serializeTopikJson(validation.value);
  const canonicalBytes = encoder.encode(canonicalText);
  if (!equalBytes(source, canonicalBytes)) {
    return failure<ParsedAssetManifest>(
      source,
      topikAssetDiagnostic(
        "TOPIK_ASSET_MANIFEST_NON_CANONICAL",
        "Manifest bytes do not match topik-json-v1 canonical serialization",
        {
          descriptorVersion: TOPIK_JSON_VERSION,
          location: { jsonPointer: "/" },
          recovery: "canonicalize-explicitly",
          consequence: "block-identity-and-writes",
        },
      ),
    );
  }
  return {
    ok: true,
    value: { manifest: validation.value, canonicalBytes },
    diagnostics: [],
    source,
  };
}

export function validateAssetManifestValue(
  value: unknown,
  capabilities: TopikAssetConsumerCapabilities = TOPIK_ASSET_DEFAULT_CAPABILITIES,
  context: AssetManifestValidationContext = {},
): TopikAssetResult<AssetManifestV1> {
  const capabilityProblem = validateCapabilities(capabilities);
  if (capabilityProblem !== undefined) return { ok: false, diagnostics: [capabilityProblem] };
  if (!isTopikJsonDataValue(value)) {
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic(
          "TOPIK_ASSET_MANIFEST_SCHEMA_INVALID",
          "Manifest must contain only own topik-json-v1 data properties",
          { descriptorVersion: TOPIK_JSON_VERSION, location: { jsonPointer: "/" } },
        ),
      ],
    };
  }
  const descriptorDiagnostic = validateDescriptors(value, capabilities);
  if (descriptorDiagnostic !== undefined) return { ok: false, diagnostics: [descriptorDiagnostic] };
  if (jsonDepth(value) > capabilities.maxJsonDepth) {
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic(
          "TOPIK_ASSET_MANIFEST_SCHEMA_INVALID",
          "Manifest exceeds the advertised JSON-depth capability",
          { descriptorVersion: TOPIK_JSON_VERSION, location: { jsonPointer: "/" } },
        ),
      ],
    };
  }
  if (!validateSchema(value)) {
    return {
      ok: false,
      diagnostics: (validateSchema.errors ?? []).map(schemaDiagnostic),
    };
  }

  const manifest = value as unknown as AssetManifestV1;
  const entries = Object.entries(manifest.assets);
  if (entries.length > capabilities.maxAssets) {
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic(
          "TOPIK_ASSET_MANIFEST_SCHEMA_INVALID",
          "Asset count exceeds capability",
          {
            location: { jsonPointer: "/assets" },
          },
        ),
      ],
    };
  }

  const diagnostics: TopikAssetDiagnostic[] = [];
  const pathOwners = new Map<string, string>();
  for (const [key, entry] of entries) {
    if (!isTopikAssetKey(key)) {
      diagnostics.push(
        topikAssetDiagnostic("TOPIK_ASSET_KEY_INVALID", "Portable asset key has invalid grammar", {
          location: { jsonPointer: `/assets/${escapePointer(key)}`, key },
        }),
      );
    }
    const path = validateTopikPath(entry.path, {
      bindingRoot: context.bindingRoot,
      capabilities,
    });
    if (!path.ok) {
      diagnostics.push(
        ...path.diagnostics.map((diagnostic) =>
          relocateTopikAssetDiagnostic(diagnostic, {
            ...diagnostic.location,
            jsonPointer: `/assets/${escapePointer(key)}/path`,
            key,
          }),
        ),
      );
    }
    const existingOwner = pathOwners.get(entry.path);
    if (existingOwner !== undefined && existingOwner !== key) {
      diagnostics.push(
        topikAssetDiagnostic("TOPIK_ASSET_PATH_COLLISION", "Two asset keys claim the same path", {
          location: { jsonPointer: `/assets/${escapePointer(key)}/path`, path: entry.path, key },
          reason: "casefold_collision",
        }),
      );
    } else {
      pathOwners.set(entry.path, key);
    }
  }
  const resourcePath = validateTopikPath(manifest.resource.path, {
    bindingRoot: context.bindingRoot,
    capabilities,
  });
  if (!resourcePath.ok) {
    diagnostics.push(
      ...resourcePath.diagnostics.map((diagnostic) =>
        relocateTopikAssetDiagnostic(diagnostic, {
          ...diagnostic.location,
          jsonPointer: "/resource/path",
        }),
      ),
    );
  }
  for (const [key, entry] of entries) {
    if (entry.path !== manifest.resource.path) continue;
    diagnostics.push(
      topikAssetDiagnostic(
        "TOPIK_ASSET_PATH_COLLISION",
        "An asset cannot claim the resource descriptor path",
        {
          location: { jsonPointer: `/assets/${escapePointer(key)}/path`, key, path: entry.path },
          reason: "casefold_collision",
        },
      ),
    );
  }
  const collisions = validateTopikPathSet(
    [...entries.map(([, entry]) => entry.path), manifest.resource.path],
    { bindingRoot: context.bindingRoot, capabilities },
  );
  if (!collisions.ok) diagnostics.push(...collisions.diagnostics);

  return diagnostics.length === 0
    ? { ok: true, value: manifest, diagnostics: [] }
    : { ok: false, value: manifest, diagnostics };
}

export function serializeAssetManifest(
  value: unknown,
  capabilities: TopikAssetConsumerCapabilities = TOPIK_ASSET_DEFAULT_CAPABILITIES,
  context: AssetManifestValidationContext = {},
): TopikAssetResult<Uint8Array> {
  const validation = validateAssetManifestValue(value, capabilities, context);
  if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };
  const bytes = encoder.encode(serializeTopikJson(validation.value));
  if (
    bytes.byteLength > TOPIK_ASSET_PORTABLE_LIMITS.maxManifestBytes ||
    bytes.byteLength > capabilities.maxManifestBytes
  ) {
    return {
      ok: false,
      diagnostics: [
        topikAssetDiagnostic("TOPIK_ASSET_MANIFEST_SCHEMA_INVALID", "Manifest exceeds capability", {
          location: { jsonPointer: "/" },
        }),
      ],
    };
  }
  const reparsed = parseAssetManifest(bytes, {
    capabilities,
    bindingRoot: context.bindingRoot,
  });
  if (!reparsed.ok) return { ok: false, diagnostics: reparsed.diagnostics };
  return { ok: true, value: reparsed.value.canonicalBytes, diagnostics: [] };
}

function validateDescriptors(
  value: unknown,
  capabilities: TopikAssetConsumerCapabilities,
): TopikAssetDiagnostic | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type !== ASSET_MANIFEST_TYPE ||
    typeof value.apiVersion !== "string" ||
    !capabilities.manifestApiVersions.includes(value.apiVersion) ||
    value.apiVersion !== ASSET_MANIFEST_API_VERSION
  ) {
    return topikAssetDiagnostic(
      "TOPIK_ASSET_MANIFEST_UNSUPPORTED_VERSION",
      "Manifest type/API version is unsupported",
      {
        descriptorVersion: `${String(value.type)}/${String(value.apiVersion)}`,
        location: { jsonPointer: "/apiVersion" },
        consequence: "block-identity-and-writes",
        recovery: "upgrade-reader",
      },
    );
  }
  if (
    typeof value.serializer === "string" &&
    (value.serializer !== TOPIK_JSON_VERSION ||
      !capabilities.serializerVersions.includes(value.serializer))
  ) {
    return topikAssetDiagnostic(
      "TOPIK_ASSET_MANIFEST_UNSUPPORTED_SERIALIZER",
      "Manifest serializer is unsupported",
      {
        descriptorVersion: value.serializer,
        location: { jsonPointer: "/serializer" },
        consequence: "block-identity-and-writes",
        recovery: "upgrade-reader",
      },
    );
  }
  if (
    typeof value.pathRules === "string" &&
    (value.pathRules !== TOPIK_PATH_VERSION ||
      !capabilities.pathRuleVersions.includes(value.pathRules))
  ) {
    return topikAssetDiagnostic(
      "TOPIK_ASSET_MANIFEST_UNSUPPORTED_PATH_RULES",
      "Manifest path rules are unsupported",
      {
        descriptorVersion: value.pathRules,
        location: { jsonPointer: "/pathRules" },
        consequence: "block-identity-and-writes",
        recovery: "upgrade-reader",
      },
    );
  }
  if (
    typeof value.referenceRules === "string" &&
    (value.referenceRules !== TOPIK_ASSET_REFERENCE_VERSION ||
      !capabilities.referenceRuleVersions.includes(value.referenceRules))
  ) {
    return topikAssetDiagnostic(
      "TOPIK_ASSET_MANIFEST_UNSUPPORTED_REFERENCE_RULES",
      "Manifest reference rules are unsupported",
      {
        descriptorVersion: value.referenceRules,
        location: { jsonPointer: "/referenceRules" },
        consequence: "block-identity-and-writes",
        recovery: "upgrade-reader",
      },
    );
  }
  return undefined;
}

function validateTopikPlainText(value: string): boolean {
  return value.normalize("NFC") === value && !FORBIDDEN_TEXT.test(value);
}

function validateSpdxExpression(expression: string): boolean {
  if (expression.normalize("NFC") !== expression || FORBIDDEN_TEXT.test(expression)) return false;
  try {
    spdxExpressionParse(expression);
    return true;
  } catch {
    return false;
  }
}

function validateCapabilities(
  capabilities: TopikAssetConsumerCapabilities,
): TopikAssetDiagnostic | undefined {
  const numericLimits = [
    ["maxManifestBytes", TOPIK_ASSET_PORTABLE_LIMITS.maxManifestBytes],
    ["maxAssets", TOPIK_ASSET_PORTABLE_LIMITS.maxAssets],
    ["maxJsonDepth", TOPIK_ASSET_PORTABLE_LIMITS.maxJsonDepth],
    ["maxComponentUtf8Bytes", TOPIK_ASSET_PORTABLE_LIMITS.maxComponentUtf8Bytes],
    ["maxComponents", TOPIK_ASSET_PORTABLE_LIMITS.maxComponents],
    ["maxRepositoryPathUtf8Bytes", TOPIK_ASSET_PORTABLE_LIMITS.maxRepositoryPathUtf8Bytes],
  ] as const;
  const invalidLimit = numericLimits.find(([name, maximum]) => {
    const value = capabilities[name];
    return !Number.isInteger(value) || value < 1 || value > maximum;
  });
  const versionLists = [
    capabilities.manifestApiVersions,
    capabilities.serializerVersions,
    capabilities.pathRuleVersions,
    capabilities.referenceRuleVersions,
  ];
  if (
    invalidLimit === undefined &&
    versionLists.every(
      (versions) =>
        Array.isArray(versions) && versions.every((version) => typeof version === "string"),
    )
  ) {
    return undefined;
  }
  return topikAssetDiagnostic(
    "TOPIK_ASSET_MANIFEST_SCHEMA_INVALID",
    "Consumer capabilities must stay within immutable portable maxima",
    {
      descriptorVersion: "AssetManifest/v1-capabilities",
      location: { jsonPointer: "/" },
      recovery: "upgrade-reader",
      consequence: "block-identity-and-writes",
    },
  );
}

function schemaDiagnostic(error: ErrorObject): TopikAssetDiagnostic {
  return topikAssetDiagnostic(
    "TOPIK_ASSET_MANIFEST_SCHEMA_INVALID",
    error.message ?? "Schema error",
    {
      location: { jsonPointer: error.instancePath || "/" },
    },
  );
}

function failure<T>(
  source: Uint8Array,
  diagnostic: TopikAssetDiagnostic,
  value?: T,
): TopikAssetResult<T> {
  return {
    ok: false,
    ...(value === undefined ? {} : { value }),
    diagnostics: [diagnostic],
    source,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const nested = Array.isArray(value) ? value : Object.values(value);
  return 1 + nested.reduce((maximum, entry) => Math.max(maximum, jsonDepth(entry)), 0);
}

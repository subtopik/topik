import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  extractTopikAssetOccurrences,
  rewriteTopikAssetOccurrences,
  type TopikAssetOccurrence,
} from "@topik/content-schema";
import type {
  Asset,
  AssetManifestEntryV1,
  AssetManifestV1,
  Guide,
  GuideV2,
  WikiPage,
  WikiPageV2,
} from "@topik/schema";
import {
  ASSET_MANIFEST_API_VERSION,
  ASSET_MANIFEST_TYPE,
  TOPIK_ASSET_REFERENCE_VERSION,
  TOPIK_JSON_VERSION,
  TOPIK_PATH_VERSION,
} from "./constants";
import {
  topikAssetDiagnostic,
  type TopikAssetDiagnostic,
  type TopikAssetResult,
} from "./diagnostics";
import { type PortableAssetFileDescriptor, validatePortableAssetFile } from "./files";
import { serializeTopikJson } from "./json";
import { generateTopikAssetKey, type GenerateTopikAssetKeyOptions } from "./key";
import { serializeAssetManifest } from "./manifest";
import { validateTopikPath } from "./path";
import { encodeTopikAssetReference } from "./reference";
import { sniffPortableMediaType, validatePortableAssetSnapshot } from "./snapshot";

export const TOPIK_LEGACY_ASSET_MIGRATION_VERSION =
  "topik-legacy-assets-v1-to-portable-v1" as const;

export interface LegacyAssetMigrationOriginal {
  contentPath: string;
  contentBytes: Uint8Array;
  resourcePath: string;
  resourceBytes: Uint8Array;
  resource: Guide | WikiPage;
  assets: readonly { resource: Asset; bytes: Uint8Array }[];
}

export interface LegacyAssetMigrationRetryState {
  version: typeof TOPIK_LEGACY_ASSET_MIGRATION_VERSION;
  keysByLegacyAsset: Readonly<Record<string, string>>;
  reservedKeys: readonly string[];
  retiredKeys: readonly string[];
}

export interface LegacyAssetByteProvider {
  read(path: string): Promise<PortableAssetFileDescriptor | undefined>;
}

export interface MigrateLegacyAssetsInput {
  original: LegacyAssetMigrationOriginal;
  byteProvider: LegacyAssetByteProvider;
  state: LegacyAssetMigrationRetryState;
  randomBytes?: GenerateTopikAssetKeyOptions["randomBytes"];
  /** Optional retained facts from a pre-rewrite compiler observation. */
  occurrencePathsByPosition?: Readonly<Record<string, string>>;
}

export interface LegacyAssetMigrationBackup {
  contentPath: string;
  contentBytes: Uint8Array;
  resourcePath: string;
  resourceBytes: Uint8Array;
  assetResources: readonly { resource: Asset; bytes: Uint8Array }[];
  files: readonly PortableAssetFileDescriptor[];
}

export interface MigratedLegacyAssets {
  version: typeof TOPIK_LEGACY_ASSET_MIGRATION_VERSION;
  resource: GuideV2 | WikiPageV2;
  resourceBytes: Uint8Array;
  content: string;
  contentBytes: Uint8Array;
  manifest: AssetManifestV1;
  manifestBytes: Uint8Array;
  files: readonly PortableAssetFileDescriptor[];
  state: LegacyAssetMigrationRetryState;
  backup: LegacyAssetMigrationBackup;
}

export async function migrateLegacyAssets(
  input: MigrateLegacyAssetsInput,
): Promise<TopikAssetResult<MigratedLegacyAssets>> {
  const diagnostics: TopikAssetDiagnostic[] = [];
  const original = input.original;
  if (input.state.version !== TOPIK_LEGACY_ASSET_MIGRATION_VERSION) {
    return legacyFailure("Migration retry-state version is unsupported");
  }
  if (
    original.resource.apiVersion !== "v1" ||
    (original.resource.type !== "Guide" && original.resource.type !== "WikiPage")
  ) {
    return legacyFailure("Migration accepts only Guide/WikiPage v1 resources");
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(original.contentBytes);
  } catch {
    return legacyFailure("Original content bytes are not strict UTF-8");
  }
  if (source !== original.resource.spec.content.value) {
    return legacyFailure("Original content bytes do not exactly match the legacy resource");
  }
  if (original.resourceBytes.byteLength === 0) {
    return legacyFailure("Exact original resource bytes are required for reversible migration");
  }

  const resourcePath = validateTopikPath(original.resourcePath);
  const contentPath = validateTopikPath(original.contentPath);
  if (!resourcePath.ok || !contentPath.ok) {
    return {
      ok: false,
      diagnostics: [
        ...(!resourcePath.ok ? resourcePath.diagnostics : []),
        ...(!contentPath.ok ? contentPath.diagnostics : []),
      ],
    };
  }

  const assetsByName = new Map<string, Array<{ resource: Asset; bytes: Uint8Array }>>();
  for (const asset of original.assets) {
    const list = assetsByName.get(asset.resource.name) ?? [];
    list.push(asset);
    assetsByName.set(asset.resource.name, list);
  }
  for (const [name, assets] of assetsByName) {
    if (assets.length > 1) {
      diagnostics.push(
        ambiguous(name, "Several legacy Asset resources share one digest-prefix/name"),
      );
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const manifestPaths = [...assetsByName.values()].map(([asset]) => asset.resource.spec.uri);
  const occurrences = extractTopikAssetOccurrences(source, {
    manifestPaths,
    declareAllLinksAsDownloads: true,
  });
  const assetByPosition = new Map<string, { resource: Asset; bytes: Uint8Array }>();
  for (const occurrence of occurrences) {
    if (occurrence.kind === "external-https") continue;
    const resolved = resolveLegacyOccurrence(occurrence, original.contentPath, assetsByName);
    if (!resolved.ok) {
      diagnostics.push(...resolved.diagnostics);
      continue;
    }
    const retainedPath = input.occurrencePathsByPosition?.[occurrence.position];
    if (retainedPath !== undefined && retainedPath !== resolved.value.resource.spec.uri) {
      diagnostics.push(
        ambiguous(
          occurrence.reference,
          "Retained occurrence path proves that the legacy digest locator collapsed path meaning",
          occurrence.position,
        ),
      );
      continue;
    }
    if (!hasAccessibleMeaning(occurrence)) {
      diagnostics.push(
        topikAssetDiagnostic(
          "TOPIK_ASSET_REFERENCE_ACCESSIBILITY_INVALID",
          "Legacy occurrence lacks recoverable accessibility meaning",
          { location: { contentPosition: occurrence.position } },
        ),
      );
      continue;
    }
    assetByPosition.set(occurrence.position, resolved.value);
  }

  const legacyManifest = original.resource.spec.assets ?? [];
  for (const name of legacyManifest) {
    if (![...assetByPosition.values()].some((asset) => asset.resource.name === name)) {
      diagnostics.push(
        topikAssetDiagnostic(
          "TOPIK_LEGACY_ASSET_REFERENCE_UNRESOLVED",
          "Legacy spec.assets member has no recoverable declared occurrence",
          { location: { key: name }, recovery: "choose-explicit-mapping" },
        ),
      );
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const uniqueAssets = new Map<string, { resource: Asset; bytes: Uint8Array }>();
  for (const asset of assetByPosition.values()) uniqueAssets.set(asset.resource.name, asset);
  const files: PortableAssetFileDescriptor[] = [];
  const verified = new Map<
    string,
    { entry: AssetManifestEntryV1; file: PortableAssetFileDescriptor }
  >();
  for (const [name, asset] of uniqueAssets) {
    const path = canonicalLegacyAssetPath(asset.resource.spec.uri);
    if (!path.ok) {
      diagnostics.push(...path.diagnostics);
      continue;
    }
    const file = await input.byteProvider.read(path.value);
    if (file === undefined) {
      diagnostics.push(
        topikAssetDiagnostic(
          "TOPIK_LEGACY_ASSET_REFERENCE_UNRESOLVED",
          "Legacy asset bytes are missing",
          {
            location: { key: name, path: path.value },
            recovery: "restore-file",
          },
        ),
      );
      continue;
    }
    if (file.path !== path.value) {
      diagnostics.push(
        topikAssetDiagnostic(
          "TOPIK_LEGACY_ASSET_REFERENCE_UNRESOLVED",
          "Byte provider returned a descriptor for a different path",
          {
            location: { key: name, path: path.value },
            recovery: "verify-bytes",
          },
        ),
      );
      continue;
    }
    const fileValidation = validatePortableAssetFile(file);
    if (!fileValidation.ok || fileValidation.value?.bytes === undefined) {
      diagnostics.push(...fileValidation.diagnostics);
      continue;
    }
    const bytes = fileValidation.value.bytes;
    const digest = createHash("sha256").update(bytes).digest();
    const sri = `sha256-${digest.toString("base64")}`;
    const hex = digest.toString("hex");
    if (sri !== asset.resource.spec.integrity) {
      diagnostics.push(
        topikAssetDiagnostic(
          "TOPIK_LEGACY_ASSET_REFERENCE_UNRESOLVED",
          "Legacy integrity does not match immutable bytes",
          { location: { key: name, path: path.value }, recovery: "verify-bytes" },
        ),
      );
      continue;
    }
    if (/^[0-9a-f]{16}$/u.test(name) && !hex.startsWith(name)) {
      diagnostics.push(ambiguous(name, "Legacy digest prefix does not match verified bytes"));
      continue;
    }
    const mediaType = sniffPortableMediaType(bytes);
    verified.set(name, {
      entry: {
        path: path.value,
        digest: { algorithm: "sha256", value: hex },
        size: bytes.byteLength,
        mediaType,
      },
      file: { ...fileValidation.value, path: path.value },
    });
    files.push({ ...fileValidation.value, path: path.value });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const nextKeys = { ...input.state.keysByLegacyAsset };
  const unavailable = new Set([
    ...input.state.reservedKeys,
    ...input.state.retiredKeys,
    ...Object.values(nextKeys),
  ]);
  for (const name of [...uniqueAssets.keys()].sort()) {
    const persistedKey = nextKeys[name];
    const key = generateTopikAssetKey({
      ...(persistedKey === undefined ? {} : { persistedKey }),
      reservedKeys: unavailable,
      retiredKeys: input.state.retiredKeys,
      randomBytes: input.randomBytes,
    });
    if (!key.ok) {
      diagnostics.push(...key.diagnostics);
      continue;
    }
    nextKeys[name] = key.value;
    unavailable.add(key.value);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const replacementByPosition = new Map<string, string>();
  for (const [position, asset] of assetByPosition) {
    const verifiedAsset = verified.get(asset.resource.name);
    const encoded = verifiedAsset && encodeTopikAssetReference(verifiedAsset.entry.path);
    if (!encoded || !encoded.ok) {
      if (encoded && !encoded.ok) diagnostics.push(...encoded.diagnostics);
      continue;
    }
    replacementByPosition.set(position, encoded.value);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const content = rewriteTopikAssetOccurrences(
    source,
    (occurrence) => replacementByPosition.get(occurrence.position),
    { manifestPaths, declareAllLinksAsDownloads: true },
  );
  const targetResource = migrateResource(original.resource, content);
  const assets: AssetManifestV1["assets"] = {};
  for (const [name, data] of verified) assets[nextKeys[name]] = data.entry;
  const manifest: AssetManifestV1 = {
    apiVersion: ASSET_MANIFEST_API_VERSION,
    assets,
    pathRules: TOPIK_PATH_VERSION,
    referenceRules: TOPIK_ASSET_REFERENCE_VERSION,
    resource: {
      apiVersion: "v2",
      type: targetResource.type,
      name: targetResource.name,
      path: original.resourcePath,
    },
    serializer: TOPIK_JSON_VERSION,
    type: ASSET_MANIFEST_TYPE,
  };
  const serialized = serializeAssetManifest(manifest);
  if (!serialized.ok) return { ok: false, diagnostics: serialized.diagnostics };

  const snapshot = validatePortableAssetSnapshot({
    manifest,
    resource: manifest.resource,
    contents: [{ path: original.contentPath, source: content }],
    files,
  });
  if (!snapshot.ok) return { ok: false, diagnostics: snapshot.diagnostics };

  const contentBytes = new TextEncoder().encode(content);
  const resourceBytes = new TextEncoder().encode(serializeTopikJson(targetResource));
  return {
    ok: true,
    value: {
      version: TOPIK_LEGACY_ASSET_MIGRATION_VERSION,
      resource: targetResource,
      resourceBytes,
      content,
      contentBytes,
      manifest,
      manifestBytes: serialized.value,
      files,
      state: {
        version: TOPIK_LEGACY_ASSET_MIGRATION_VERSION,
        keysByLegacyAsset: nextKeys,
        reservedKeys: [
          ...new Set([...input.state.reservedKeys, ...Object.values(nextKeys)]),
        ].sort(),
        retiredKeys: [...input.state.retiredKeys],
      },
      backup: {
        contentPath: original.contentPath,
        contentBytes: Uint8Array.from(original.contentBytes),
        resourcePath: original.resourcePath,
        resourceBytes: Uint8Array.from(original.resourceBytes),
        assetResources: original.assets.map((asset) => ({
          resource: structuredClone(asset.resource),
          bytes: Uint8Array.from(asset.bytes),
        })),
        files: files.map((file) => ({
          ...file,
          ...(file.bytes === undefined ? {} : { bytes: Uint8Array.from(file.bytes) }),
        })),
      },
    },
    diagnostics: [],
  };
}

function migrateResource(resource: Guide | WikiPage, content: string): GuideV2 | WikiPageV2 {
  const { assets: _legacyAssets, ...spec } = resource.spec;
  const migratedSpec = { ...spec, content: { ...spec.content, value: content } };
  return {
    ...resource,
    apiVersion: "v2",
    spec: migratedSpec,
  } as GuideV2 | WikiPageV2;
}

function resolveLegacyOccurrence(
  occurrence: TopikAssetOccurrence,
  contentPath: string,
  assetsByName: ReadonlyMap<string, Array<{ resource: Asset; bytes: Uint8Array }>>,
): TopikAssetResult<{ resource: Asset; bytes: Uint8Array }> {
  if (occurrence.reference.startsWith("asset:")) {
    const name = occurrence.reference.slice("asset:".length);
    const candidates = assetsByName.get(name) ?? [];
    if (candidates.length === 1) return { ok: true, value: candidates[0], diagnostics: [] };
    return {
      ok: false,
      diagnostics: [
        candidates.length > 1
          ? ambiguous(name, "Legacy digest-prefix locator is non-unique", occurrence.position)
          : unresolved(name, occurrence.position),
      ],
    };
  }
  const resolvedPath = resolveLegacyPath(occurrence.reference, contentPath);
  if (resolvedPath === undefined) {
    return { ok: false, diagnostics: [unresolved(occurrence.reference, occurrence.position)] };
  }
  const candidates = [...assetsByName.values()]
    .flat()
    .filter((asset) => asset.resource.spec.uri === resolvedPath);
  if (candidates.length === 1) return { ok: true, value: candidates[0], diagnostics: [] };
  return {
    ok: false,
    diagnostics: [
      candidates.length > 1
        ? ambiguous(
            occurrence.reference,
            "Legacy path resolves to several Asset resources",
            occurrence.position,
          )
        : unresolved(occurrence.reference, occurrence.position),
    ],
  };
}

function resolveLegacyPath(reference: string, contentPath: string): string | undefined {
  if (reference.includes("?") || reference.includes("#")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    return undefined;
  }
  const resolved = decoded.startsWith("/")
    ? posix.normalize(decoded.slice(1))
    : posix.normalize(posix.join(posix.dirname(contentPath), decoded));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved))
    return undefined;
  return resolved;
}

function canonicalLegacyAssetPath(uri: string): TopikAssetResult<string> {
  const decoded = resolveLegacyPath(uri.startsWith("/") ? uri : `/${uri}`, "content.md");
  if (decoded === undefined)
    return legacyFailure("Legacy Asset URI cannot be proven resource-root relative");
  const path = validateTopikPath(decoded);
  return path.ok
    ? { ok: true, value: path.value.path, diagnostics: [] }
    : { ok: false, diagnostics: path.diagnostics };
}

function hasAccessibleMeaning(occurrence: TopikAssetOccurrence): boolean {
  if (occurrence.role === "download")
    return (occurrence.semantics.linkLabel?.trim().length ?? 0) > 0;
  if (occurrence.slot.startsWith("figure."))
    return (occurrence.semantics.alt?.trim().length ?? 0) > 0;
  return (
    occurrence.semantics.decorative === true || (occurrence.semantics.alt?.trim().length ?? 0) > 0
  );
}

function legacyFailure<T>(message: string): TopikAssetResult<T> {
  return { ok: false, diagnostics: [unresolved(message)] };
}

function unresolved(value: string, position?: string): TopikAssetDiagnostic {
  return topikAssetDiagnostic(
    "TOPIK_LEGACY_ASSET_REFERENCE_UNRESOLVED",
    `Legacy asset fact is unresolved: ${value}`,
    {
      descriptorVersion: TOPIK_LEGACY_ASSET_MIGRATION_VERSION,
      location: position === undefined ? {} : { contentPosition: position },
      recovery: "choose-explicit-mapping",
    },
  );
}

function ambiguous(value: string, message: string, position?: string): TopikAssetDiagnostic {
  return topikAssetDiagnostic("TOPIK_LEGACY_ASSET_REFERENCE_AMBIGUOUS", message, {
    descriptorVersion: TOPIK_LEGACY_ASSET_MIGRATION_VERSION,
    location: {
      key: safe(value),
      ...(position === undefined ? {} : { contentPosition: position }),
    },
    recovery: "choose-explicit-mapping",
  });
}

function safe(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

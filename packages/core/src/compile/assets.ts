import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { posix } from "node:path";
import {
  extractTopikAssetOccurrences,
  rewriteTopikAssetOccurrences,
  validateTopikAssetReference,
  type TopikAssetOccurrence,
} from "@topik/content-schema";
import type { Asset, CoursePage, Guide, WikiPage } from "@topik/schema";
import { parseDocument } from "yaml";
import type { Resource } from "../resource";
import {
  generateImplicitAssetName,
  isExplicitAssetName,
  validateAssetUri,
  validateAssetValue,
} from "../portable/asset";
import { TOPIK_ASSET_LIMITS, TOPIK_ASSET_OUTPUT_PREFIX } from "../portable/constants";
import { topikAssetDiagnostic, type TopikAssetDiagnostic } from "../portable/diagnostics";
import { readPortableAssetFile } from "../portable/files";
import {
  createTopikAssetSemanticRecord,
  createTopikMaterializationRecord,
  validateTopikMaterializationRecord,
  type TopikAssetReferenceMappingV1,
  type TopikAssetSemanticRecordV1,
  type TopikMaterializationRecordV1,
} from "../portable/identity";
import { parseStrictTopikJson, serializeTopikJson } from "../portable/json";
import {
  isInlineMediaCompatible,
  isTopikActiveMediaType,
  sniffPortableMediaType,
} from "../portable/media";
import { validateTopikPath, validateTopikPathSet } from "../portable/path";
import { validateResources, type ValidationError } from "../validate";

export type ContentBearingResource = CoursePage | Guide | WikiPage;

export interface AssetCompilationOptions {
  /** Required only when supported implicit local references occur. */
  sourceNamespace?: string;
  /** Explicit generic-link download positions, keyed by `Type/name`. */
  downloadableLinkPositionsByResource?: Readonly<Record<string, readonly string[]>>;
  /** Active local bytes are rejected unless every occurrence is a download and this is true. */
  allowActiveDownloads?: boolean;
  /** Deterministic generated-name collision seam. Production callers omit it. */
  generatedNameHash?: (bytes: Uint8Array) => Uint8Array;
}

export interface CompileAssetResourcesInput extends AssetCompilationOptions {
  rootDir: string;
  resources: readonly Resource[];
  /** Compilation-root-relative source paths keyed by `Type/name`. */
  sourcePathsByResource: Readonly<Record<string, string>>;
  /** Other consumed compiler inputs that cannot be owned as Asset bytes. */
  protectedSourcePaths?: readonly string[];
  /** Additional programmatic declarations. On-disk descriptors are still discovered. */
  assets?: readonly Asset[];
  discoverDescriptors?: boolean;
}

export interface AssetPayload {
  path: string;
  integrity: `sha256:${string}`;
  mediaType: string;
  size: number;
  bytes: Uint8Array;
  assetNames: readonly string[];
}

export interface AssetCompilationResult {
  resources: Resource[];
  payloads: AssetPayload[];
  semantic: TopikAssetSemanticRecordV1;
  materialization: TopikMaterializationRecordV1;
}

export interface LoadedAssetDescriptor {
  path: string;
  asset: Asset;
}

export class AssetCompilationError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: readonly TopikAssetDiagnostic[] = [],
  ) {
    super(message);
    this.name = "AssetCompilationError";
  }
}

/** Discover closed Asset descriptors below compilation-root `assets/` in canonical path order. */
export async function loadAssetDescriptors(rootDir: string): Promise<LoadedAssetDescriptor[]> {
  let entries: string[];
  try {
    entries = (await readdir(`${rootDir}/assets`, {
      recursive: true,
      encoding: "utf8",
    })) as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const paths = entries
    .filter((entry) => /\.(?:json|ya?ml)$/u.test(entry))
    .map((entry) => `assets/${entry.replaceAll("\\", "/")}`)
    .sort(compareUtf8);
  const pathSet = validateTopikPathSet(paths);
  if (!pathSet.ok)
    throw new AssetCompilationError("Asset descriptor paths collide", pathSet.diagnostics);

  const loaded: LoadedAssetDescriptor[] = [];
  for (const path of paths) {
    const read = await readPortableAssetFile({ root: rootDir, path });
    if (!read.ok || read.value.bytes === undefined) {
      throw new AssetCompilationError(
        "Asset descriptor could not be read safely",
        read.diagnostics,
      );
    }
    if (read.value.bytes.byteLength > TOPIK_ASSET_LIMITS.maxDescriptorBytes) {
      throw new AssetCompilationError("Asset descriptor exceeds the byte limit", [
        topikAssetDiagnostic(
          "TOPIK_ASSET_SCHEMA_INVALID",
          "Asset descriptor exceeds the byte limit",
          {
            location: { path },
          },
        ),
      ]);
    }
    const asset = parseDescriptor(read.value.bytes, path);
    if (!isExplicitAssetName(asset.name)) {
      throw new AssetCompilationError("Authored Asset uses the reserved generated-name prefix", [
        topikAssetDiagnostic("TOPIK_ASSET_NAME_INVALID", "Authored Asset name is reserved", {
          location: { key: asset.name, path },
        }),
      ]);
    }
    loaded.push({ path, asset });
  }
  return loaded;
}

/** Resolve one compilation-wide named Asset set and one deduplicated payload inventory. */
export async function compileAssetResources(
  input: CompileAssetResourcesInput,
): Promise<AssetCompilationResult> {
  const descriptorResources =
    input.discoverDescriptors === false ? [] : await loadAssetDescriptors(input.rootDir);
  const nonAssetResources = input.resources.filter((resource) => resource.type !== "Asset");
  const declaredAssets = [
    ...input.resources.filter((resource): resource is Asset => resource.type === "Asset"),
    ...(input.assets ?? []),
    ...descriptorResources.map((descriptor) => descriptor.asset),
  ];
  const reservedDeclaration = declaredAssets.find((asset) => !isExplicitAssetName(asset.name));
  if (reservedDeclaration !== undefined) {
    throw new AssetCompilationError("Explicit Asset uses the reserved generated-name prefix", [
      topikAssetDiagnostic("TOPIK_ASSET_NAME_INVALID", "Explicit Asset name is reserved", {
        location: { key: reservedDeclaration.name },
      }),
    ]);
  }
  if (declaredAssets.length > TOPIK_ASSET_LIMITS.maxAssets) {
    throw new AssetCompilationError("Compilation exceeds its Asset limit");
  }
  const initialValidation = validateResources([...nonAssetResources, ...declaredAssets]);
  if (!initialValidation.valid) {
    throw new AssetCompilationError(
      "Asset compilation received an invalid resource",
      resourceValidationDiagnostics(initialValidation.errors, [
        ...nonAssetResources,
        ...declaredAssets,
      ]),
    );
  }

  const sourcePaths = new Map<string, string>();
  for (const [resource, source] of Object.entries(input.sourcePathsByResource)) {
    const path = requirePath(source, "Content source path is not portable");
    if (sourcePaths.has(resource))
      throw new AssetCompilationError("Content source binding repeats");
    sourcePaths.set(resource, path);
  }
  const contentResources = nonAssetResources.filter(isContentBearingResource);
  const topikContentResources = contentResources.filter(isTopikContentResource);
  for (const resource of contentResources) {
    if (!sourcePaths.has(resourceKey(resource))) {
      throw new AssetCompilationError("Content-bearing resource lacks a source-path binding");
    }
  }
  for (const key of sourcePaths.keys()) {
    if (!contentResources.some((resource) => resourceKey(resource) === key)) {
      throw new AssetCompilationError("Source-path binding names a non-content resource");
    }
  }

  const assetsByName = new Map<string, Asset>();
  for (const asset of declaredAssets) {
    if (assetsByName.has(asset.name)) {
      throw collision("More than one explicit Asset declaration uses the same name", asset.name);
    }
    assetsByName.set(asset.name, cloneAsset(asset));
  }

  const readCache = new Map<string, Awaited<ReturnType<typeof requireAssetFile>>>();
  const localPathByGeneratedName = new Map<string, string>();
  const replacements = new Map<string, Map<string, string>>();
  const pendingNamedReferences: Array<{
    resource: string;
    occurrence: TopikAssetOccurrence;
    name: string;
  }> = [];
  const mappings: TopikAssetReferenceMappingV1[] = [];
  const rolesByName = new Map<string, string[]>();
  const allPaths = new Set<string>(sourcePaths.values());
  const protectedPaths = new Set<string>(sourcePaths.values());
  for (const source of input.protectedSourcePaths ?? []) {
    const path = requirePath(source, "Protected compiler source path is not portable");
    allPaths.add(path);
    protectedPaths.add(path);
  }
  const explicitLocalPaths = new Set<string>();
  for (const descriptor of descriptorResources) {
    allPaths.add(descriptor.path);
    protectedPaths.add(descriptor.path);
  }
  for (const asset of declaredAssets) {
    const uri = validateAssetUri(asset.spec.uri);
    if (!uri.ok || uri.value.kind !== "local") continue;
    if (protectedPaths.has(uri.value.uri)) {
      throw ambiguousReference(
        "Explicit Asset path conflicts with a resource source",
        uri.value.uri,
      );
    }
    explicitLocalPaths.add(uri.value.uri);
    allPaths.add(uri.value.uri);
  }

  for (const resource of topikContentResources) {
    const key = resourceKey(resource);
    const sourcePath = sourcePaths.get(key) as string;
    const explicitlyDownloadable = new Set(input.downloadableLinkPositionsByResource?.[key] ?? []);
    const resourceReplacements = new Map<string, string>();
    replacements.set(key, resourceReplacements);
    const occurrences = extractTopikAssetOccurrences(resource.spec.content.value, {
      includeGenericLinkCandidates: true,
      downloadableLinkPositions: explicitlyDownloadable,
    });
    for (const occurrence of occurrences) {
      if (occurrence.kind === "asset") {
        const name = occurrence.reference.slice("asset:".length);
        pendingNamedReferences.push({ resource: key, occurrence, name });
        continue;
      }
      if (occurrence.kind === "external-https") continue;
      if (occurrence.kind === "unsafe") {
        if (occurrence.slot === "link.href" && !explicitlyDownloadable.has(occurrence.position)) {
          continue;
        }
        throw referenceError(
          "Asset-capable slot contains an unsafe reference",
          occurrence,
          sourcePath,
        );
      }

      const ordinaryNavigation =
        occurrence.slot === "link.href" && !explicitlyDownloadable.has(occurrence.position);
      let normalizedPath: string;
      if (ordinaryNavigation) {
        try {
          normalizedPath = resolveOccurrencePath(sourcePath, occurrence.reference);
        } catch (error) {
          if (error instanceof AssetCompilationError) continue;
          throw error;
        }
      } else {
        normalizedPath = resolveOccurrencePath(sourcePath, occurrence.reference);
      }
      if (protectedPaths.has(normalizedPath)) {
        if (ordinaryNavigation) continue;
        throw ambiguousReference(
          "Local reference conflicts with a resource or explicit Asset path",
          normalizedPath,
          occurrence.position,
        );
      }
      if (ordinaryNavigation) {
        const proof = await readPortableAssetFile({ root: input.rootDir, path: normalizedPath });
        if (!proof.ok || proof.value.bytes === undefined) continue;
        readCache.set(normalizedPath, proof.value as Awaited<ReturnType<typeof requireAssetFile>>);
      }
      if (input.sourceNamespace === undefined) {
        throw new AssetCompilationError(
          "Implicit Asset references require a stable source namespace",
          [
            topikAssetDiagnostic(
              "TOPIK_ASSET_SOURCE_NAMESPACE_REQUIRED",
              "Provide the versioned stable source namespace option",
              { location: { path: normalizedPath, contentPosition: occurrence.position } },
            ),
          ],
        );
      }
      const generated = generateImplicitAssetName({
        stableSourceNamespace: input.sourceNamespace,
        normalizedPath,
        hash: input.generatedNameHash,
      });
      if (!generated.ok)
        throw new AssetCompilationError(
          "Implicit Asset name could not be generated",
          generated.diagnostics,
        );
      const name = generated.value;
      const previousPath = localPathByGeneratedName.get(name);
      if (previousPath !== undefined && previousPath !== normalizedPath) {
        throw collision("Generated Asset name collides with another normalized path", name);
      }
      if (assetsByName.has(name) && previousPath === undefined) {
        throw collision("Generated Asset name conflicts with an explicit Asset", name);
      }
      localPathByGeneratedName.set(name, normalizedPath);
      if (!assetsByName.has(name)) {
        if (assetsByName.size >= TOPIK_ASSET_LIMITS.maxAssets) {
          throw new AssetCompilationError("Compilation exceeds its Asset limit");
        }
        assetsByName.set(name, {
          apiVersion: "v1",
          type: "Asset",
          name,
          spec: { uri: normalizedPath },
        });
      }
      resourceReplacements.set(occurrence.position, `asset:${name}`);
      addMapping(mappings, rolesByName, key, occurrence, name);
      allPaths.add(normalizedPath);
    }
  }

  for (const pending of pendingNamedReferences) {
    if (!assetsByName.has(pending.name)) {
      throw new AssetCompilationError("Canonical Asset reference has no declaration", [
        topikAssetDiagnostic("TOPIK_ASSET_REFERENCE_MISSING", "Named Asset does not exist", {
          location: {
            key: pending.name,
            contentPosition: pending.occurrence.position,
          },
        }),
      ]);
    }
    addMapping(mappings, rolesByName, pending.resource, pending.occurrence, pending.name);
  }

  const completePathSet = validateTopikPathSet([...allPaths]);
  if (!completePathSet.ok) {
    throw new AssetCompilationError("Compilation paths collide", completePathSet.diagnostics);
  }

  const resolvedAssets: Asset[] = [];
  const payloadsByDigest = new Map<
    string,
    { bytes: Uint8Array; mediaType: string; names: Set<string> }
  >();
  for (const asset of assetsByName.values()) {
    const uri = validateAssetUri(asset.spec.uri);
    if (!uri.ok) throw new AssetCompilationError("Asset URI is invalid", uri.diagnostics);
    const roles = rolesByName.get(asset.name) ?? [];
    if (uri.value.kind === "remote") {
      if (isTopikActiveMediaType(asset.spec.mediaType ?? "")) {
        throw activeError(asset.name, asset.spec.uri);
      }
      assertRoleMediaCompatibility(asset.name, asset.spec.uri, asset.spec.mediaType ?? "", roles);
      resolvedAssets.push(cloneAsset(asset));
      continue;
    }
    const file =
      readCache.get(uri.value.uri) ?? (await requireAssetFile(input.rootDir, uri.value.uri));
    readCache.set(uri.value.uri, file);
    const digest = sha256(file.bytes);
    const integrity = `sha256:${digest}` as const;
    const mediaType = sniffPortableMediaType(file.bytes);
    verifyExactFacts(asset, integrity, file.bytes.byteLength, mediaType);
    if (isTopikActiveMediaType(mediaType)) {
      if (
        !(
          input.allowActiveDownloads === true &&
          roles.length > 0 &&
          roles.every((role) => role === "download")
        )
      ) {
        throw activeError(asset.name, uri.value.uri);
      }
    }
    assertRoleMediaCompatibility(asset.name, uri.value.uri, mediaType, roles);
    const payloadPath = `${TOPIK_ASSET_OUTPUT_PREFIX}/${digest}`;
    resolvedAssets.push({
      ...cloneAsset(asset),
      spec: {
        ...cloneAsset(asset).spec,
        uri: payloadPath,
        integrity,
        size: file.bytes.byteLength,
        mediaType,
      },
    });
    const payload = payloadsByDigest.get(digest);
    if (payload !== undefined) {
      if (!equalBytes(payload.bytes, file.bytes)) {
        throw new AssetCompilationError("SHA-256 payload collision was detected");
      }
      payload.names.add(asset.name);
    } else {
      payloadsByDigest.set(digest, { bytes: file.bytes, mediaType, names: new Set([asset.name]) });
    }
  }

  const rewritten = nonAssetResources.map((resource): Resource => {
    if (!isContentBearingResource(resource)) return resource;
    const key = resourceKey(resource);
    const byPosition = replacements.get(key);
    if (byPosition === undefined || byPosition.size === 0) return resource;
    const content = rewriteTopikAssetOccurrences(
      resource.spec.content.value,
      (occurrence) => byPosition.get(occurrence.position),
      { includeGenericLinkCandidates: true },
    );
    return {
      ...resource,
      spec: { ...resource.spec, content: { ...resource.spec.content, value: content } },
    } as Resource;
  });
  const resources = [...rewritten, ...resolvedAssets].sort(compareResources);
  const finalValidation = validateResources(resources);
  if (!finalValidation.valid) {
    throw new AssetCompilationError(
      "Compiled resources are invalid",
      resourceValidationDiagnostics(finalValidation.errors, resources),
    );
  }
  const payloads: AssetPayload[] = [...payloadsByDigest.entries()]
    .map(([digest, payload]) => ({
      path: `${TOPIK_ASSET_OUTPUT_PREFIX}/${digest}`,
      integrity: `sha256:${digest}` as const,
      mediaType: payload.mediaType,
      size: payload.bytes.byteLength,
      bytes: payload.bytes,
      assetNames: [...payload.names].sort(compareUtf8),
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const semantic = createTopikAssetSemanticRecord(resolvedAssets, mappings);
  const materialization = createTopikMaterializationRecord(
    resources.map((resource) => ({
      resource,
      bytes: new TextEncoder().encode(serializeTopikJson(resource)),
    })),
    payloads.map((payload) => ({
      path: payload.path,
      bytes: payload.bytes,
      assetNames: payload.assetNames,
    })),
  );
  const inventory = validateTopikMaterializationRecord(materialization, resolvedAssets);
  if (!inventory.ok)
    throw new AssetCompilationError("Compiled inventory is incomplete", inventory.diagnostics);
  return { resources, payloads, semantic, materialization };
}

function assertRoleMediaCompatibility(
  name: string,
  path: string,
  mediaType: string,
  roles: readonly string[],
): void {
  const incompatible = roles.find(
    (role) => role !== "download" && !isInlineMediaCompatible(mediaType, role),
  );
  if (incompatible === undefined) return;
  throw new AssetCompilationError("Asset media type is incompatible with its reference role", [
    topikAssetDiagnostic(
      "TOPIK_ASSET_MEDIA_TYPE_MISMATCH",
      "Asset media type is incompatible with its reference role",
      { location: { key: name, path } },
    ),
  ]);
}

function resourceValidationDiagnostics(
  errors: readonly ValidationError[],
  resources: readonly unknown[],
): TopikAssetDiagnostic[] {
  return errors.map((error) => {
    const resource = resources.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        Object.hasOwn(candidate, "type") &&
        Object.hasOwn(candidate, "name") &&
        `${String((candidate as { type: unknown }).type)}/${String((candidate as { name: unknown }).name)}` ===
          error.resource,
    ) as { apiVersion?: unknown; name?: unknown; type?: unknown } | undefined;
    const descriptorVersion = safeResourceDescriptorVersion(resource);
    return topikAssetDiagnostic(
      error.id === "resource-unsupported-version"
        ? "TOPIK_ASSET_UNSUPPORTED_VERSION"
        : "TOPIK_ASSET_SCHEMA_INVALID",
      error.id === "resource-unsupported-version"
        ? "Resource apiVersion is unsupported"
        : "Resource schema validation failed",
      {
        descriptorVersion,
        location: {
          jsonPointer: error.path,
        },
      },
    );
  });
}

const KNOWN_RESOURCE_TYPES = new Set([
  "Asset",
  "Course",
  "CourseModule",
  "CoursePage",
  "Guide",
  "Person",
  "Wiki",
  "WikiPage",
]);

function safeResourceDescriptorVersion(
  resource:
    | {
        apiVersion?: unknown;
        type?: unknown;
      }
    | undefined,
): string {
  if (typeof resource?.type !== "string" || !KNOWN_RESOURCE_TYPES.has(resource.type)) {
    return "unknown-resource";
  }
  return `${resource.type}/${resource.apiVersion === "v1" ? "v1" : "unsupported"}`;
}

function parseDescriptor(bytes: Uint8Array, path: string): Asset {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AssetCompilationError("Asset descriptor is not strict UTF-8");
  }
  let value: unknown;
  try {
    if (path.endsWith(".json")) {
      value = parseStrictTopikJson(source, TOPIK_ASSET_LIMITS.maxJsonDepth);
    } else {
      const document = parseDocument(source, { strict: true, uniqueKeys: true });
      if (document.errors.length > 0 || document.contents === null) throw new Error("Invalid YAML");
      value = document.toJS({ maxAliasCount: 0 });
    }
  } catch {
    throw new AssetCompilationError("Asset descriptor has invalid or duplicate syntax", [
      topikAssetDiagnostic("TOPIK_ASSET_DUPLICATE_MEMBER", "Asset descriptor syntax is invalid", {
        location: { path },
      }),
    ]);
  }
  const validation = validateAssetValue(value);
  if (!validation.ok)
    throw new AssetCompilationError("Asset descriptor is invalid", validation.diagnostics);
  return validation.value;
}

async function requireAssetFile(root: string, path: string) {
  const read = await readPortableAssetFile({ root, path });
  if (!read.ok || read.value.bytes === undefined) {
    throw new AssetCompilationError("Local Asset bytes could not be proven", read.diagnostics);
  }
  return read.value as typeof read.value & { bytes: Uint8Array };
}

function resolveOccurrencePath(sourcePath: string, reference: string): string {
  const validation = validateTopikAssetReference(reference);
  if (!validation.valid || validation.kind !== "local") {
    throw new AssetCompilationError("Local occurrence path is invalid", [
      topikAssetDiagnostic("TOPIK_ASSET_PATH_INVALID", "Local occurrence path is invalid"),
    ]);
  }
  const joined = posix.join(posix.dirname(sourcePath), validation.decodedPath);
  return requirePath(joined, "Resolved Asset path is outside the compilation root");
}

function verifyExactFacts(
  asset: Asset,
  integrity: `sha256:${string}`,
  size: number,
  mediaType: string,
): void {
  const checks: Array<[boolean, Parameters<typeof topikAssetDiagnostic>[0], string]> = [
    [
      asset.spec.integrity === undefined || asset.spec.integrity === integrity,
      "TOPIK_ASSET_DIGEST_MISMATCH",
      "Provided integrity differs from local bytes",
    ],
    [
      asset.spec.size === undefined || asset.spec.size === size,
      "TOPIK_ASSET_SIZE_MISMATCH",
      "Provided size differs from local bytes",
    ],
    [
      asset.spec.mediaType === undefined || asset.spec.mediaType === mediaType,
      "TOPIK_ASSET_MEDIA_TYPE_MISMATCH",
      "Provided media type differs from local bytes",
    ],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed !== undefined) {
    throw new AssetCompilationError("Local Asset exact facts do not match", [
      topikAssetDiagnostic(failed[1], failed[2], {
        location: { key: asset.name, path: asset.spec.uri },
        recovery: "verify-bytes",
      }),
    ]);
  }
}

function addMapping(
  mappings: TopikAssetReferenceMappingV1[],
  rolesByName: Map<string, string[]>,
  resource: string,
  occurrence: TopikAssetOccurrence,
  name: string,
): void {
  mappings.push({ resource, position: occurrence.position, slot: occurrence.slot, name });
  const roles = rolesByName.get(name) ?? [];
  roles.push(occurrence.role);
  rolesByName.set(name, roles);
  if (!hasAccessibleMeaning(occurrence)) {
    throw new AssetCompilationError("Asset occurrence lacks accessible meaning", [
      topikAssetDiagnostic(
        "TOPIK_ASSET_REFERENCE_ACCESSIBILITY_INVALID",
        "Asset occurrence lacks schema-supported accessible meaning",
        { location: { key: name, contentPosition: occurrence.position } },
      ),
    ]);
  }
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

function isContentBearingResource(resource: Resource): resource is ContentBearingResource {
  return (
    resource.type === "Guide" || resource.type === "WikiPage" || resource.type === "CoursePage"
  );
}

function isTopikContentResource(resource: ContentBearingResource): boolean {
  return resource.spec.content.format === "topik";
}

function requirePath(path: string, message: string): string {
  const validation = validateTopikPath(path);
  if (!validation.ok) throw new AssetCompilationError(message, validation.diagnostics);
  return validation.value.path;
}

function resourceKey(resource: { type: string; name: string }): string {
  return `${resource.type}/${resource.name}`;
}

function cloneAsset(asset: Asset): Asset {
  return structuredClone(asset);
}

function collision(message: string, name: string): AssetCompilationError {
  return new AssetCompilationError(message, [
    topikAssetDiagnostic("TOPIK_ASSET_NAME_COLLISION", message, { location: { key: name } }),
  ]);
}

function referenceError(
  message: string,
  occurrence: TopikAssetOccurrence,
  path: string,
): AssetCompilationError {
  return new AssetCompilationError(message, [
    topikAssetDiagnostic("TOPIK_ASSET_REFERENCE_MALFORMED", message, {
      location: { path, contentPosition: occurrence.position },
    }),
  ]);
}

function ambiguousReference(
  message: string,
  path: string,
  contentPosition?: string,
): AssetCompilationError {
  return new AssetCompilationError(message, [
    topikAssetDiagnostic("TOPIK_ASSET_REFERENCE_AMBIGUOUS", message, {
      location: { path, ...(contentPosition === undefined ? {} : { contentPosition }) },
    }),
  ]);
}

function activeError(name: string, path: string): AssetCompilationError {
  return new AssetCompilationError("Asset media is active or incompatible with its slot", [
    topikAssetDiagnostic(
      "TOPIK_ASSET_ACTIVE_CONTENT_UNSUPPORTED",
      "Asset media is active or incompatible with its slot",
      { location: { key: name, path } },
    ),
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function compareResources(left: Resource, right: Resource): number {
  return compareUtf8(resourceKey(left), resourceKey(right));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

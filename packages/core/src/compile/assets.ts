import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  extractTopikAssetOccurrences,
  rewriteTopikAssetOccurrences,
  validateTopikContent,
  validateTopikAssetReference,
  type TopikAssetOccurrence,
  type TopikContentDiagnostic,
} from "@topik/content-schema";
import type { Asset, CoursePage, GeneratedAssetName, Guide, WikiPage } from "@topik/schema";
import type { Resource, SourceResource } from "../resource";
import { generateAutomaticAssetName } from "../assets/asset";
import { TOPIK_ASSET_LIMITS, TOPIK_ASSET_OUTPUT_PREFIX } from "../assets/constants";
import {
  TOPIK_ASSET_DIAGNOSTIC_IDS,
  topikAssetDiagnostic,
  type TopikAssetDiagnostic,
  type TopikAssetDiagnosticId,
} from "../assets/diagnostics";
import {
  classifyPortableNavigationPath,
  readPortableAssetFile,
  readPortableAssetFileWithReadHookForTest,
} from "../assets/files";
import {
  createTopikAssetSemanticRecord,
  createTopikMaterializationRecord,
  validateTopikMaterializationRecord,
  type TopikAssetReferenceMappingV1,
  type TopikAssetSemanticRecordV1,
  type TopikMaterializationRecordV1,
} from "../assets/identity";
import { serializeTopikJson } from "../assets/json";
import {
  isInlineMediaCompatible,
  isTopikActiveMediaType,
  sniffPortableMediaType,
} from "../assets/media";
import { validateTopikPath, validateTopikPathSet } from "../assets/path";
import { validateResources, type ValidationError } from "../validate";

export type ContentBearingResource = CoursePage | Guide | WikiPage;

export interface AssetCompilationOptions {
  /** Required only when supported local references are discovered automatically. */
  sourceNamespace?: string;
}

export interface CompileAssetResourcesInput extends AssetCompilationOptions {
  rootDir: string;
  resources: readonly SourceResource[];
  /** Compilation-root-relative source paths keyed by `Type/name`. */
  sourcePathsByResource: Readonly<Record<string, string>>;
  /** Other consumed compiler inputs that cannot be owned as Asset bytes. */
  protectedSourcePaths?: readonly string[];
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

export class AssetCompilationError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: readonly TopikAssetDiagnostic[] = [],
  ) {
    super(message);
    this.name = "AssetCompilationError";
  }
}

/** Discover and resolve one compilation-wide Asset set and deduplicated payload inventory. */
export async function compileAssetResources(
  input: CompileAssetResourcesInput,
): Promise<AssetCompilationResult> {
  return compileAssetResourcesWithReader(input, readPortableAssetFile);
}

/** @internal Deterministic file-read race seam; not re-exported from the package root. */
export async function compileAssetResourcesWithReadHookForTest(
  input: CompileAssetResourcesInput,
  afterFileRead: () => void | Promise<void>,
): Promise<AssetCompilationResult> {
  return compileAssetResourcesWithReader(input, (options) =>
    readPortableAssetFileWithReadHookForTest(options, afterFileRead),
  );
}

type PortableAssetReader = typeof readPortableAssetFile;

async function compileAssetResourcesWithReader(
  input: CompileAssetResourcesInput,
  readAssetFile: PortableAssetReader,
): Promise<AssetCompilationResult> {
  const receivedResources = input.resources as readonly Resource[];
  if (receivedResources.some((resource) => resource.type === "Asset")) {
    throw new AssetCompilationError("Asset resources are compiler output and cannot be inputs", [
      topikAssetDiagnostic(
        "TOPIK_ASSET_SCHEMA_INVALID",
        "Asset resources are compiler output and cannot be inputs",
      ),
    ]);
  }
  const sourceResources = receivedResources as readonly SourceResource[];
  const initialValidation = validateResources(sourceResources);
  if (!initialValidation.valid) {
    throw new AssetCompilationError(
      "Asset compilation received an invalid resource",
      resourceValidationDiagnostics(initialValidation.errors, sourceResources),
    );
  }

  const sourcePaths = new Map<string, string>();
  for (const [resource, source] of Object.entries(input.sourcePathsByResource)) {
    const path = requirePath(source, "Content source path is not portable");
    if (sourcePaths.has(resource))
      throw new AssetCompilationError("Content source binding repeats");
    sourcePaths.set(resource, path);
  }
  const contentResources = sourceResources.filter(isContentBearingResource);
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
  for (const resource of topikContentResources) {
    const sourcePath = sourcePaths.get(resourceKey(resource)) as string;
    const navigationDiagnostics = validateTopikContent(resource.spec.content.value, {
      file: sourcePath,
    }).errors.filter(isUnsupportedAssetNavigationDiagnostic);
    if (navigationDiagnostics.length > 0) {
      throw new AssetCompilationError(
        "Source content cannot use Asset locators for navigation-only targets",
        navigationDiagnostics.map((diagnostic) =>
          topikAssetDiagnostic(
            "TOPIK_ASSET_REFERENCE_MALFORMED",
            "Navigation-only targets cannot use Asset locators",
            { location: { path: diagnostic.file ?? sourcePath } },
          ),
        ),
      );
    }
  }

  const readCache = new Map<string, Awaited<ReturnType<typeof requireAssetFile>>>();
  const localPathByGeneratedName = new Map<GeneratedAssetName, string>();
  const replacements = new Map<string, Map<string, string>>();
  const mappings: TopikAssetReferenceMappingV1[] = [];
  const rolesByName = new Map<string, string[]>();
  const allPaths = new Set<string>(sourcePaths.values());
  const protectedPaths = new Set<string>(sourcePaths.values());
  for (const source of input.protectedSourcePaths ?? []) {
    const path = requirePath(source, "Protected compiler source path is not portable");
    allPaths.add(path);
    protectedPaths.add(path);
  }
  for (const resource of topikContentResources) {
    const key = resourceKey(resource);
    const sourcePath = sourcePaths.get(key) as string;
    const resourceReplacements = new Map<string, string>();
    replacements.set(key, resourceReplacements);
    const occurrences = extractTopikAssetOccurrences(resource.spec.content.value, {
      includeGenericLinkCandidates: true,
    });
    for (const occurrence of occurrences) {
      if (occurrence.kind === "asset" || occurrence.kind === "reserved-asset") {
        throw referenceError(
          "Source content cannot use the reserved Asset locator scheme",
          occurrence,
          sourcePath,
        );
      }
      if (occurrence.kind === "external-https") continue;
      if (occurrence.kind === "unsafe") {
        const parsedValidation = validateTopikAssetReference(occurrence.parsedReference);
        if (
          !parsedValidation.valid &&
          parsedValidation.failureKind === "external" &&
          /^https?:/iu.test(occurrence.parsedReference)
        ) {
          throw referenceError(
            "Asset-capable slot contains an unsafe reference",
            occurrence,
            sourcePath,
            occurrence.parsedReference,
          );
        }
        if (
          occurrence.reference.length === 0 &&
          parsedValidation.valid &&
          parsedValidation.kind === "external-https"
        ) {
          continue;
        }
        if (occurrence.slot === "link.href") {
          if (parsedValidation.valid && parsedValidation.kind === "local") {
            let parsedPath: string;
            try {
              parsedPath = resolveOccurrencePath(sourcePath, occurrence.parsedReference);
            } catch (error) {
              if (error instanceof AssetCompilationError) continue;
              throw error;
            }
            if (protectedPaths.has(parsedPath)) continue;
            const proof = await readGenericNavigationCandidate(
              readAssetFile,
              input.rootDir,
              parsedPath,
            );
            if (proof !== undefined) {
              throw referenceError(
                "Proven download reference is not canonical",
                occurrence,
                sourcePath,
              );
            }
            continue;
          }
          if (!/^https?:/iu.test(occurrence.reference)) continue;
        }
        throw referenceError(
          "Asset-capable slot contains an unsafe reference",
          occurrence,
          sourcePath,
        );
      }

      const ordinaryNavigation = occurrence.slot === "link.href";
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
          "Local reference conflicts with a compiler input path",
          normalizedPath,
          occurrence.position,
        );
      }
      if (ordinaryNavigation) {
        const proof = await readGenericNavigationCandidate(
          readAssetFile,
          input.rootDir,
          normalizedPath,
        );
        if (proof === undefined) continue;
        readCache.set(normalizedPath, proof);
      }
      if (input.sourceNamespace === undefined) {
        throw new AssetCompilationError(
          "Automatic Asset discovery requires a stable source namespace",
          [
            topikAssetDiagnostic(
              "TOPIK_ASSET_SOURCE_NAMESPACE_REQUIRED",
              "Provide the versioned stable source namespace option",
              { location: { path: normalizedPath, contentPosition: occurrence.position } },
            ),
          ],
        );
      }
      const generated = generateAutomaticAssetName({
        stableSourceNamespace: input.sourceNamespace,
        normalizedPath,
      });
      if (!generated.ok)
        throw new AssetCompilationError(
          "Automatic Asset name could not be generated",
          generated.diagnostics,
        );
      const name = generated.value;
      registerGeneratedAssetPath(localPathByGeneratedName, name, normalizedPath);
      if (localPathByGeneratedName.size > TOPIK_ASSET_LIMITS.maxAssets) {
        throw new AssetCompilationError("Compilation exceeds its Asset limit");
      }
      resourceReplacements.set(occurrence.position, `asset:${name}`);
      addMapping(mappings, rolesByName, key, occurrence, name);
      allPaths.add(normalizedPath);
    }
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
  for (const [name, sourcePath] of localPathByGeneratedName) {
    const roles = rolesByName.get(name) ?? [];
    const file =
      readCache.get(sourcePath) ??
      (await requireAssetFile(input.rootDir, sourcePath, readAssetFile));
    readCache.set(sourcePath, file);
    const digest = sha256(file.bytes);
    const integrity = `sha256:${digest}` as const;
    const mediaType = sniffPortableMediaType(file.bytes);
    if (isTopikActiveMediaType(mediaType)) {
      throw activeError(name, sourcePath);
    }
    assertRoleMediaCompatibility(name, sourcePath, mediaType, roles);
    const payloadPath = `${TOPIK_ASSET_OUTPUT_PREFIX}/${digest}` as const;
    resolvedAssets.push({
      apiVersion: "v1",
      type: "Asset",
      name,
      spec: {
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
      payload.names.add(name);
    } else {
      payloadsByDigest.set(digest, { bytes: file.bytes, mediaType, names: new Set([name]) });
    }
  }

  const rewritten = sourceResources.map((resource): Resource => {
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
  const inventory = validateTopikMaterializationRecord(materialization, resources, semantic);
  if (!inventory.ok)
    throw new AssetCompilationError("Compiled inventory is incomplete", inventory.diagnostics);
  return { resources, payloads, semantic, materialization };
}

/** @internal Shared with the source test suite to prove generated-name collision handling. */
export function registerGeneratedAssetPath(
  paths: Map<GeneratedAssetName, string>,
  name: GeneratedAssetName,
  normalizedPath: string,
): void {
  const previousPath = paths.get(name);
  if (previousPath !== undefined && previousPath !== normalizedPath) {
    throw collision("Generated Asset name collides with another normalized path", name);
  }
  paths.set(name, normalizedPath);
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
    const diagnosticId = isTopikAssetDiagnosticId(error.id)
      ? error.id
      : error.id === "resource-unsupported-version"
        ? "TOPIK_ASSET_UNSUPPORTED_VERSION"
        : "TOPIK_ASSET_SCHEMA_INVALID";
    return topikAssetDiagnostic(
      diagnosticId,
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

function isTopikAssetDiagnosticId(value: ValidationError["id"]): value is TopikAssetDiagnosticId {
  return TOPIK_ASSET_DIAGNOSTIC_IDS.some((id) => id === value);
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

async function requireAssetFile(root: string, path: string, readAssetFile: PortableAssetReader) {
  const read = await readAssetFile({ root, path });
  if (!read.ok || read.value.bytes === undefined) {
    throw new AssetCompilationError("Local Asset bytes could not be proven", read.diagnostics);
  }
  return read.value as typeof read.value & { bytes: Uint8Array };
}

async function readGenericNavigationCandidate(
  readAssetFile: PortableAssetReader,
  root: string,
  path: string,
): Promise<Awaited<ReturnType<typeof requireAssetFile>> | undefined> {
  if ((await classifyPortableNavigationPath({ root, path })) === "directory") return undefined;
  const proof = await readAssetFile({ root, path });
  if (!proof.ok) {
    if (proof.diagnostics.every((diagnostic) => diagnostic.id === "TOPIK_ASSET_FILE_MISSING")) {
      return undefined;
    }
    throw new AssetCompilationError(
      "Existing generic-link target failed portable Asset proof",
      proof.diagnostics,
    );
  }
  return proof.value.bytes === undefined
    ? undefined
    : (proof.value as Awaited<ReturnType<typeof requireAssetFile>>);
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

function isUnsupportedAssetNavigationDiagnostic(diagnostic: TopikContentDiagnostic): boolean {
  return diagnostic.id === "link-asset-navigation-unsupported";
}

function requirePath(path: string, message: string): string {
  const validation = validateTopikPath(path);
  if (!validation.ok) throw new AssetCompilationError(message, validation.diagnostics);
  return validation.value.path;
}

function resourceKey(resource: { type: string; name: string }): string {
  return `${resource.type}/${resource.name}`;
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
  effectiveReference: string = occurrence.reference,
): AssetCompilationError {
  const validation = validateTopikAssetReference(effectiveReference);
  const diagnosticId =
    occurrence.kind === "asset" || occurrence.kind === "reserved-asset"
      ? "TOPIK_ASSET_REFERENCE_MALFORMED"
      : !validation.valid && validation.failureKind === "external"
        ? "TOPIK_EXTERNAL_REFERENCE_UNSAFE"
        : "TOPIK_ASSET_REFERENCE_MALFORMED";
  return new AssetCompilationError(message, [
    topikAssetDiagnostic(diagnosticId, message, {
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

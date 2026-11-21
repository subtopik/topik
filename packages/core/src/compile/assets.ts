import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import {
  extractTopikAssetOccurrences,
  rewriteTopikAssetOccurrences,
  validateTopikAssetReference,
  type TextTemplate,
  type TopikAssetOccurrence,
  type TopikContentDiagnostic,
} from "@topik/content";
import type { CoursePage } from "@topik/schema/course-page/v1";
import type { Guide } from "@topik/schema/guide/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { Resource, SourceResource } from "../resource";
import {
  isGeneratedAssetName,
  parseAssetBlobUri,
  type AssetBlobUri,
  type CompiledAsset,
  type GeneratedAssetName,
} from "../assets/asset";
import { TOPIK_ASSET_LIMITS, TOPIK_BLOB_OUTPUT_PREFIX } from "../assets/constants";
import {
  TOPIK_ASSET_DIAGNOSTIC_IDS,
  topikAssetDiagnostic,
  type TopikAssetDiagnostic,
  type TopikAssetDiagnosticId,
} from "../assets/diagnostics";
import {
  classifyPortableNavigationPath,
  createPortableReadSession,
  portableReadFailureReason,
  readPortableAssetFile,
  type FileSafety,
  readPortableAssetFileInSession,
  readPortableAssetFileWithReadHookForTest,
  type PortableReadSession,
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
import { createContentMemo, type ContentMemo } from "./content-memo";
import type { PublicCompileErrorReason } from "./public-errors";

export type ContentBearingResource = CoursePage | Guide | WikiPage;

export interface AssetNameInput {
  /** Absolute native path after resolving the authored reference within its allowed root.
   * This is a file location, not a portable identity or a delivery URL. */
  resolvedAssetPath: string;
}

/** Return a stable, canonical auto-v1 name. Called once per distinct asset path per compilation. */
export type AssetNameGenerator = (input: AssetNameInput) => string | Promise<string>;

export interface AssetCompilationOptions {
  /** Required only when supported local references are discovered automatically. */
  generateName?: AssetNameGenerator;
}

export interface CompileAssetResourcesInput extends AssetCompilationOptions {
  rootDir: string;
  resources: readonly SourceResource[];
  /** Compilation-root-relative source paths keyed by `Type/name`. */
  sourcePathsByResource: Readonly<Record<string, string>>;
  /** Optional per-document containment directories relative to rootDir (empty for root).
   * Asset identities still use paths relative to rootDir. */
  sourceDirectoriesByResource?: Readonly<Record<string, string>>;
  /** Other consumed compiler inputs that cannot be owned as Asset bytes. */
  protectedSourcePaths?: readonly string[];
  /**
   * @internal When given, a failure in one document or one Asset is recorded here and the rest
   * are still checked; compilation then ends with {@link AssetFailuresCollected}.
   */
  failures?: AssetCompilationFailure[];
}

/** @internal An Asset failure and the source paths of the documents it was found in. */
export interface AssetCompilationFailure {
  error: AssetCompilationError;
  documents: readonly string[];
}

/** @internal Ends a collecting compilation once failures were recorded in `input.failures`. */
export class AssetFailuresCollected extends Error {
  constructor() {
    super("Asset compilation failures were collected");
    this.name = "AssetFailuresCollected";
  }
}

export interface AssetPayload {
  path: AssetBlobUri;
  integrity: `sha256:${string}`;
  mediaType: string;
  size: number;
  bytes: Uint8Array;
  assetNames: readonly string[];
}

export interface AssetCompilationResult {
  resources: CompiledResource[];
  payloads: AssetPayload[];
  /**
   * The source file of each generated local Asset: Asset name to its path relative to the
   * compilation root (the project directory for a manifest), with `/` separators. Several names
   * can share one payload, so pair a payload with its files through `AssetPayload.assetNames`.
   * An Asset with an external `https` reference has no entry. This is caller-side provenance:
   * it is not part of the semantic or materialization records and is never written to output.
   */
  assetSourcePaths: Readonly<Record<string, string>>;
  semantic: TopikAssetSemanticRecordV1;
  materialization: TopikMaterializationRecordV1;
}

export type CompiledResource = SourceResource | CompiledAsset;

export class AssetCompilationError extends Error {
  /**
   * Why a local Asset file was refused, when the reader knows: for example `git-lfs-pointer`
   * for a file that holds a Git LFS pointer in place of its content, or `too-large`. Absent
   * for every other Asset failure. The diagnostic wording is not a stable surface; this is.
   */
  declare public readonly reason?: PublicCompileErrorReason;

  constructor(
    message: string,
    public readonly diagnostics: readonly TopikAssetDiagnostic[] = [],
    options?: { reason?: PublicCompileErrorReason },
  ) {
    super(message);
    this.name = "AssetCompilationError";
    if (options?.reason !== undefined) this.reason = options.reason;
  }
}

/** Discover and resolve one compilation-wide Asset set and deduplicated payload inventory. */
export async function compileAssetResources(
  input: CompileAssetResourcesInput,
): Promise<AssetCompilationResult> {
  return compileAssetResourcesInSession(createPortableReadSession(), input);
}

/** @internal Asset compilation sharing repository evidence with the rest of a build. */
export async function compileAssetResourcesInSession(
  session: PortableReadSession,
  input: CompileAssetResourcesInput,
  memo: ContentMemo = createContentMemo(),
): Promise<AssetCompilationResult> {
  return compileAssetResourcesWithReader(
    input,
    (options) => readPortableAssetFileInSession(session, options),
    session.fileSafety,
    memo,
  );
}

/** @internal Deterministic file-read race seam; not re-exported from the package root. */
export async function compileAssetResourcesWithReadHookForTest(
  input: CompileAssetResourcesInput,
  afterFileRead: () => void | Promise<void>,
): Promise<AssetCompilationResult> {
  const session = createPortableReadSession();
  return compileAssetResourcesWithReader(
    input,
    (options) => readPortableAssetFileWithReadHookForTest(options, afterFileRead, session),
    session.fileSafety,
  );
}

type PortableAssetReader = typeof readPortableAssetFile;

async function compileAssetResourcesWithReader(
  input: CompileAssetResourcesInput,
  readAssetFile: PortableAssetReader,
  fileSafety: FileSafety,
  memo: ContentMemo = createContentMemo(),
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
  const contentKeys = new Set(contentResources.map(resourceKey));
  for (const key of sourcePaths.keys()) {
    if (!contentKeys.has(key)) {
      throw new AssetCompilationError("Source-path binding names a non-content resource");
    }
  }
  for (const resource of topikContentResources) {
    const sourcePath = sourcePaths.get(resourceKey(resource)) as string;
    const validation = memo.validate(resource.spec.content.value, sourcePath);
    if (!validation.ok) {
      throw new AssetCompilationError(
        "Asset compilation received invalid Topik content",
        contentValidationDiagnostics(validation.diagnostics, sourcePath),
      );
    }
  }

  const readCache = new Map<string, Awaited<ReturnType<typeof requireAssetFile>>>();
  // Generic links are probed once per path, however many occurrences link to it.
  const navigationProbes = new Map<
    string,
    Awaited<ReturnType<typeof requireAssetFile>> | undefined
  >();
  const probeNavigationCandidate = async (path: string) => {
    if (navigationProbes.has(path)) return navigationProbes.get(path);
    const proof = await readGenericNavigationCandidate(
      readAssetFile,
      input.rootDir,
      path,
      fileSafety,
    );
    navigationProbes.set(path, proof);
    return proof;
  };
  const localPathByGeneratedName = new Map<GeneratedAssetName, string>();
  const generatedNameByPath = new Map<string, GeneratedAssetName>();
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
  // Collect a failure for a document or an Asset, or throw it when not collecting.
  const recordFailure = (error: unknown, documents: readonly string[]) => {
    if (input.failures === undefined || !(error instanceof AssetCompilationError)) throw error;
    input.failures.push({ error, documents });
  };
  for (const resource of topikContentResources) {
    const key = resourceKey(resource);
    const sourcePath = sourcePaths.get(key) as string;
    try {
      await collectDocumentAssets(resource, key, sourcePath);
    } catch (error) {
      recordFailure(error, [sourcePath]);
    }
  }
  async function collectDocumentAssets(
    resource: (typeof topikContentResources)[number],
    key: string,
    sourcePath: string,
  ): Promise<void> {
    const directory = input.sourceDirectoriesByResource?.[key] ?? "";
    if (directory !== "") {
      requirePath(directory, "Asset containment directory is not portable");
      if (!sourcePath.startsWith(`${directory}/`))
        throw new AssetCompilationError(
          "Content source is outside its Asset containment directory",
        );
    }
    const localSourcePath = directory === "" ? sourcePath : sourcePath.slice(directory.length + 1);
    const resolveLocalPath = (reference: string) =>
      posix.join(directory, resolveOccurrencePath(localSourcePath, reference));
    const resourceReplacements = new Map<string, string>();
    replacements.set(key, resourceReplacements);
    const occurrences = extractTopikAssetOccurrences(resource.spec.content.value, {
      includeGenericLinkCandidates: true,
      cache: memo.cache,
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
              parsedPath = resolveLocalPath(occurrence.parsedReference);
            } catch (error) {
              if (error instanceof AssetCompilationError) continue;
              throw error;
            }
            if (protectedPaths.has(parsedPath)) continue;
            const proof = await probeNavigationCandidate(parsedPath);
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
          normalizedPath = resolveLocalPath(occurrence.reference);
        } catch (error) {
          if (error instanceof AssetCompilationError) continue;
          throw error;
        }
      } else {
        normalizedPath = resolveLocalPath(occurrence.reference);
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
        const proof = await probeNavigationCandidate(normalizedPath);
        if (proof === undefined) continue;
        readCache.set(normalizedPath, proof);
      }
      if (input.generateName === undefined) {
        throw new AssetCompilationError("Automatic Asset discovery requires a name generator", [
          topikAssetDiagnostic(
            "TOPIK_ASSET_NAME_GENERATOR_REQUIRED",
            "Provide an Asset name generator",
            { location: { path: normalizedPath, contentPosition: occurrence.position } },
          ),
        ]);
      }
      let name = generatedNameByPath.get(normalizedPath);
      if (name === undefined) {
        const generated = await input.generateName({
          resolvedAssetPath: resolve(input.rootDir, normalizedPath),
        });
        if (!isGeneratedAssetName(generated)) {
          throw new AssetCompilationError("Asset name generator returned an invalid name", [
            topikAssetDiagnostic("TOPIK_ASSET_NAME_INVALID", "Expected a canonical auto-v1 name", {
              location: { path: normalizedPath },
            }),
          ]);
        }
        name = generated;
        generatedNameByPath.set(normalizedPath, name);
      }
      registerGeneratedAssetPath(localPathByGeneratedName, name, normalizedPath);
      if (localPathByGeneratedName.size > TOPIK_ASSET_LIMITS.maxAssets) {
        throw new AssetCompilationError("Compilation exceeds its Asset limit");
      }
      resourceReplacements.set(occurrence.position, `asset:${name}`);
      addMapping(mappings, rolesByName, key, occurrence, name);
      allPaths.add(normalizedPath);
    }
  }
  if (input.failures?.length) throw new AssetFailuresCollected();

  const completePathSet = validateTopikPathSet([...allPaths]);
  if (!completePathSet.ok) {
    throw new AssetCompilationError("Compilation paths collide", completePathSet.diagnostics);
  }

  const resolvedAssets: CompiledAsset[] = [];
  const payloadsByDigest = new Map<
    string,
    { bytes: Uint8Array; mediaType: string; names: Set<string> }
  >();
  for (const [name, sourcePath] of localPathByGeneratedName) {
    try {
      await resolveAsset(name, sourcePath);
    } catch (error) {
      const documents = new Set(
        mappings
          .filter((mapping) => mapping.name === name)
          .map((mapping) => sourcePaths.get(mapping.resource) as string),
      );
      recordFailure(error, [...documents].sort(compareUtf8));
    }
  }
  if (input.failures?.length) throw new AssetFailuresCollected();
  async function resolveAsset(name: GeneratedAssetName, sourcePath: string): Promise<void> {
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
    const payloadPath = parseAssetBlobUri(`${TOPIK_BLOB_OUTPUT_PREFIX}/${digest}`);
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

  const rewritten = sourceResources.map((resource): SourceResource => {
    if (!isContentBearingResource(resource)) return resource;
    const key = resourceKey(resource);
    const sourcePath = sourcePaths.get(key) as string;
    const byPosition = replacements.get(key);
    if (byPosition === undefined || byPosition.size === 0) return resource;
    const rewrittenContent = rewriteTopikAssetOccurrences(
      resource.spec.content.value,
      (occurrence) => byPosition.get(occurrence.position),
      { includeGenericLinkCandidates: true, file: sourcePath, cache: memo.cache },
    );
    if (!rewrittenContent.ok) {
      throw new AssetCompilationError(
        "Asset compilation could not rewrite invalid content",
        contentValidationDiagnostics(rewrittenContent.diagnostics, sourcePath),
      );
    }
    return {
      ...resource,
      spec: {
        ...resource.spec,
        content: { ...resource.spec.content, value: rewrittenContent.content },
      },
    } as SourceResource;
  });
  const resources: CompiledResource[] = [...rewritten, ...resolvedAssets].sort(compareResources);
  const finalValidation = validateResources(resources);
  if (!finalValidation.valid) {
    throw new AssetCompilationError(
      "Compiled resources are invalid",
      resourceValidationDiagnostics(finalValidation.errors, resources),
    );
  }
  const payloads: AssetPayload[] = [...payloadsByDigest.entries()]
    .map(([digest, payload]) => ({
      path: parseAssetBlobUri(`${TOPIK_BLOB_OUTPUT_PREFIX}/${digest}`),
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
  const inventory = validateTopikMaterializationRecord(materialization, resources, semantic, {
    cache: memo.cache,
  });
  if (!inventory.ok)
    throw new AssetCompilationError("Compiled inventory is incomplete", inventory.diagnostics);
  const assetSourcePaths = Object.fromEntries(
    [...localPathByGeneratedName].sort(([left], [right]) => compareUtf8(left, right)),
  );
  return { resources, payloads, assetSourcePaths, semantic, materialization };
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

function isTopikAssetDiagnosticId(value: string | undefined): value is TopikAssetDiagnosticId {
  return TOPIK_ASSET_DIAGNOSTIC_IDS.some((id) => id === value);
}

function contentValidationDiagnostics(
  diagnostics: readonly TopikContentDiagnostic[],
  sourcePath: string,
): TopikAssetDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const lines = diagnostic.lines.filter((line) => line > 0);
    const unsupportedNavigation = diagnostic.id === "link-asset-navigation-unsupported";
    const id = unsupportedNavigation
      ? "TOPIK_ASSET_REFERENCE_MALFORMED"
      : isTopikAssetDiagnosticId(diagnostic.id)
        ? diagnostic.id
        : "TOPIK_ASSET_SCHEMA_INVALID";
    return topikAssetDiagnostic(
      id,
      unsupportedNavigation
        ? "Navigation-only targets cannot use Asset locators"
        : diagnostic.message,
      {
        location: {
          path: diagnostic.file ?? sourcePath,
          ...(lines.length === 0 ? {} : { contentPosition: `line ${lines.join(",")}` }),
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

async function requireAssetFile(root: string, path: string, readAssetFile: PortableAssetReader) {
  const read = await readAssetFile({ root, path });
  if (!read.ok || read.value.bytes === undefined) {
    throw new AssetCompilationError("Local Asset bytes could not be proven", read.diagnostics, {
      reason: portableReadFailureReason(read.diagnostics),
    });
  }
  return read.value as typeof read.value & { bytes: Uint8Array };
}

async function readGenericNavigationCandidate(
  readAssetFile: PortableAssetReader,
  root: string,
  path: string,
  fileSafety: FileSafety,
): Promise<Awaited<ReturnType<typeof requireAssetFile>> | undefined> {
  if ((await classifyPortableNavigationPath({ root, path, fileSafety })) === "directory") {
    return undefined;
  }
  const proof = await readAssetFile({ root, path });
  if (!proof.ok) {
    if (proof.diagnostics.every((diagnostic) => diagnostic.id === "TOPIK_ASSET_FILE_MISSING")) {
      return undefined;
    }
    throw new AssetCompilationError(
      "Existing generic-link target failed portable Asset proof",
      proof.diagnostics,
      { reason: portableReadFailureReason(proof.diagnostics) },
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
  // Templates declare accessible authoring intent without resolving application context.
  if (occurrence.slot.startsWith("figure."))
    return hasText(occurrence.semantics.alt, occurrence.semantics.altTemplate);
  // A video and its poster are named by the video title.
  if (occurrence.slot.startsWith("video."))
    return hasText(occurrence.semantics.title, occurrence.semantics.titleTemplate);
  return (
    occurrence.semantics.decorative === true || (occurrence.semantics.alt?.trim().length ?? 0) > 0
  );
}

function hasText(value: string | undefined, template: TextTemplate | undefined): boolean {
  return (
    (value?.trim().length ?? 0) > 0 ||
    template?.segments.some(
      (segment) => segment.type === "variable" || segment.value.trim().length > 0,
    ) === true
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

import { createHash } from "node:crypto";
import {
  extractTopikAssetOccurrences,
  validateTopikAssetReference,
  type TopikAssetOccurrence,
} from "@topik/content-schema";
import type { AssetManifestV1, CoursePage, Guide, WikiPage } from "@topik/schema";
import type { Resource } from "../resource";
import { validateResources } from "../validate";
import { ASSET_MANIFEST_SIDECAR_PATH } from "../portable/constants";
import { topikAssetDiagnostic, type TopikAssetDiagnostic } from "../portable/diagnostics";
import { readPortableAssetFile, type PortableAssetFileDescriptor } from "../portable/files";
import {
  createTopikAssetSemanticRecord,
  createTopikMaterializationRecord,
  type TopikAssetSemanticRecordV1,
  type TopikMaterializationFileInput,
  type TopikMaterializationRecordV1,
} from "../portable/identity";
import { generateTopikAssetKey, isTopikAssetKey } from "../portable/key";
import { serializeTopikJson } from "../portable/json";
import { serializeAssetManifest } from "../portable/manifest";
import { validateTopikPath, validateTopikPathSet } from "../portable/path";
import {
  decodeTopikAssetReference,
  validateTopikExternalAssetReference,
} from "../portable/reference";
import {
  sniffPortableMediaType,
  validatePortableAssetSnapshot,
  type ValidatedPortableAssetSnapshot,
} from "../portable/snapshot";

export const TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION = "topik-portable-asset-keys-v1" as const;

export type ContentBearingResource = CoursePage | Guide | WikiPage;

export interface PortableAssetKeyStateV1 {
  version: typeof TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION;
  /** Stable path-to-key assignments, scoped by `Type/name`. */
  keysByResource: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Deleted keys remain unavailable only inside their owning resource history. */
  retiredKeysByResource: Readonly<Record<string, readonly string[]>>;
}

export interface PortableAssetCompilationOptions {
  keyState?: PortableAssetKeyStateV1;
  /** Explicit generic-link download positions, keyed by `Type/name`. */
  downloadableLinkPositionsByResource?: Readonly<Record<string, readonly string[]>>;
  /** Test/retry seam. Production callers omit this to use the CSPRNG. */
  randomBytes?: (size: number) => Uint8Array;
}

export interface CompilePortableResourceArtifactsInput {
  /** Absolute filesystem root used for anchored, no-follow reads. */
  rootDir: string;
  /** Content-bearing and container resources in caller-defined deterministic order. */
  resources: readonly Resource[];
  /** Source paths relative to rootDir, keyed by `Type/name`, for content-bearing resources only. */
  sourcePathsByResource: Readonly<Record<string, string>>;
  /** Explicit declarations for generic link slots that are downloads. */
  downloadableLinkPositionsByResource?: Readonly<Record<string, readonly string[]>>;
  keyState?: PortableAssetKeyStateV1;
  /** Test/retry seam. Production callers omit this to use the CSPRNG. */
  randomBytes?: (size: number) => Uint8Array;
}

export interface PortableResourceArtifact {
  /** Collision-free output root relative to a materialization directory. */
  resourceRoot: string;
  resource: ContentBearingResource;
  manifest: AssetManifestV1;
  manifestBytes: Uint8Array;
  /** Complete owned files: descriptor, content, assets, and canonical sidecar. */
  inventory: readonly TopikMaterializationFileInput[];
  snapshot: ValidatedPortableAssetSnapshot;
  semantic: TopikAssetSemanticRecordV1;
  materialization: TopikMaterializationRecordV1;
}

export interface PortableResourceCompilationResult {
  resources: Resource[];
  artifacts: PortableResourceArtifact[];
  keyState: PortableAssetKeyStateV1;
}

export class PortableAssetCompilationError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: readonly TopikAssetDiagnostic[] = [],
  ) {
    super(message);
    this.name = "PortableAssetCompilationError";
  }
}

/** Compile the only supported asset model directly for every content-bearing resource. */
export async function compilePortableResourceArtifacts(
  input: CompilePortableResourceArtifactsInput,
): Promise<PortableResourceCompilationResult> {
  const resourceValidation = validateResources(input.resources);
  if (!resourceValidation.valid) {
    throw new PortableAssetCompilationError("Portable compilation received an invalid resource");
  }
  const state = copyAndValidateState(input.keyState);
  const seenResources = new Set<string>();
  const rewrittenResources: Resource[] = [];
  const artifacts: PortableResourceArtifact[] = [];
  const contentResourceKeys = new Set<string>();
  const resourceSourcePaths = new Set(
    Object.values(input.sourcePathsByResource).map((path) =>
      requirePath(path, "Content source path is not portable"),
    ),
  );

  for (const resource of input.resources) {
    const resourceKey = topikResourceKey(resource);
    if (seenResources.has(resourceKey)) {
      throw new PortableAssetCompilationError("Portable compilation repeats a resource identity");
    }
    seenResources.add(resourceKey);
    if (!isContentBearingResource(resource)) {
      rewrittenResources.push(resource);
      continue;
    }
    contentResourceKeys.add(resourceKey);
    if (!Object.hasOwn(input.sourcePathsByResource, resourceKey)) {
      throw new PortableAssetCompilationError(
        "Content-bearing resource is missing an explicit source-path binding",
      );
    }
    const downloadableLinkPositions = readDownloadablePositions(
      input.downloadableLinkPositionsByResource,
      resourceKey,
    );
    const artifact = await compileOneResource({
      resource,
      rootDir: input.rootDir,
      sourcePath: input.sourcePathsByResource[resourceKey],
      resourceSourcePaths,
      downloadableLinkPositions,
      assignments: state.keysByResource.get(resourceKey) ?? new Map(),
      retiredKeys: state.retiredKeysByResource.get(resourceKey) ?? new Set(),
      randomBytes: input.randomBytes,
    });
    state.keysByResource.set(resourceKey, artifact.assignments);
    state.retiredKeysByResource.set(resourceKey, artifact.retiredKeys);
    rewrittenResources.push(artifact.value.resource);
    artifacts.push(artifact.value);
  }

  for (const resourceKey of Object.keys(input.sourcePathsByResource)) {
    if (!contentResourceKeys.has(resourceKey)) {
      throw new PortableAssetCompilationError(
        "Source-path bindings may name only compiled content-bearing resources",
      );
    }
  }

  artifacts.sort((left, right) => compareUtf8(left.resourceRoot, right.resourceRoot));
  const roots = validateTopikPathSet(artifacts.map((artifact) => artifact.resourceRoot));
  if (!roots.ok) {
    throw new PortableAssetCompilationError(
      "Portable resource output roots collide",
      roots.diagnostics,
    );
  }
  return { resources: rewrittenResources, artifacts, keyState: materializeKeyState(state) };
}

interface CompileOneInput {
  resource: ContentBearingResource;
  rootDir: string;
  sourcePath: string;
  resourceSourcePaths: ReadonlySet<string>;
  downloadableLinkPositions: readonly string[];
  assignments: ReadonlyMap<string, string>;
  retiredKeys: ReadonlySet<string>;
  randomBytes?: (size: number) => Uint8Array;
}

async function compileOneResource(input: CompileOneInput): Promise<{
  value: PortableResourceArtifact;
  assignments: Map<string, string>;
  retiredKeys: Set<string>;
}> {
  requirePath(input.sourcePath, "Content source path is not portable");
  const resourceRoot = requirePath(
    `${input.resource.type}/${input.resource.name}`,
    "Resource output root is not portable",
  );
  const descriptorPath = "resource.json";
  const contentPath = "content.topik";
  const extracted = extractTopikAssetOccurrences(input.resource.spec.content.value, {
    downloadableLinkPositions: input.downloadableLinkPositions,
    includeGenericLinkCandidates: true,
  });
  const explicitlyDownloadable = new Set(input.downloadableLinkPositions);
  const downloadablePositions = new Set(input.downloadableLinkPositions);
  const localByPosition = new Map<string, { path: string; reference: string }>();
  const assetFiles = new Map<string, PortableAssetFileDescriptor & { bytes: Uint8Array }>();
  for (const occurrence of extracted) {
    if (occurrence.slot === "link.href" && !explicitlyDownloadable.has(occurrence.position)) {
      const proven = await provePlainDownload(occurrence, input, assetFiles);
      if (proven === undefined) continue;
      downloadablePositions.add(occurrence.position);
      localByPosition.set(occurrence.position, proven);
      continue;
    }
    const resolved = resolveCanonicalLocalReference(occurrence);
    if (resolved === undefined) continue;
    if (occurrence.slot === "link.href" && input.resourceSourcePaths.has(resolved.path)) {
      throw new PortableAssetCompilationError("Download declaration conflicts with a resource", [
        topikAssetDiagnostic(
          "TOPIK_ASSET_REFERENCE_AMBIGUOUS",
          "Declared download resolves to a compiled resource source",
          { location: { contentPosition: occurrence.position, path: resolved.path } },
        ),
      ]);
    }
    localByPosition.set(occurrence.position, resolved);
  }
  const content = input.resource.spec.content.value;

  const assignments = new Map(input.assignments);
  const retiredKeys = new Set(input.retiredKeys);
  const assets: AssetManifestV1["assets"] = Object.create(null) as AssetManifestV1["assets"];
  const paths = [...new Set([...localByPosition.values()].map((entry) => entry.path))].sort(
    compareUtf8,
  );
  const currentPaths = new Set(paths);
  for (const [path, key] of assignments) {
    if (!currentPaths.has(path)) {
      assignments.delete(path);
      retiredKeys.add(key);
    }
  }
  const reservedKeys = new Set(assignments.values());
  const completePaths = validateTopikPathSet([descriptorPath, contentPath, ...paths], {
    bindingRoot: resourceRoot,
  });
  if (!completePaths.ok) {
    throw new PortableAssetCompilationError(
      "Portable resource-owned paths collide",
      completePaths.diagnostics,
    );
  }

  for (const path of paths) {
    const persistedKey = assignments.get(path);
    const generated = generateTopikAssetKey({
      ...(persistedKey === undefined ? {} : { persistedKey }),
      randomBytes: input.randomBytes,
      reservedKeys,
      retiredKeys,
    });
    if (!generated.ok) {
      throw new PortableAssetCompilationError(
        "Portable asset key allocation failed",
        generated.diagnostics,
      );
    }
    const key = generated.value;
    const existingAssignment = [...assignments].find(
      ([otherPath, otherKey]) => otherPath !== path && otherKey === key,
    );
    if (existingAssignment !== undefined || (persistedKey === undefined && reservedKeys.has(key))) {
      throw new PortableAssetCompilationError("Portable key state assigns one key more than once");
    }
    assignments.set(path, key);
    reservedKeys.add(key);

    let file = assetFiles.get(path);
    if (file === undefined) {
      const read = await readPortableAssetFile({ root: input.rootDir, path });
      if (!read.ok || read.value.bytes === undefined) {
        throw new PortableAssetCompilationError(
          "Portable asset bytes could not be proven",
          read.diagnostics,
        );
      }
      file = read.value as PortableAssetFileDescriptor & { bytes: Uint8Array };
      assetFiles.set(path, file);
    }
    assets[key] = {
      digest: { algorithm: "sha256", value: sha256(file.bytes) },
      mediaType: sniffPortableMediaType(file.bytes),
      path,
      size: file.bytes.byteLength,
    };
  }

  const resource = replaceResourceContent(input.resource, content);
  const manifest: AssetManifestV1 = {
    apiVersion: "v1",
    assets,
    pathRules: "topik-path-v1",
    referenceRules: "topik-asset-reference-v1",
    resource: {
      apiVersion: resource.apiVersion,
      name: resource.name,
      path: descriptorPath,
      type: resource.type,
    },
    serializer: "topik-json-v1",
    type: "AssetManifest",
  };
  const serializedManifest = serializeAssetManifest(manifest, undefined, {
    bindingRoot: resourceRoot,
  });
  if (!serializedManifest.ok) {
    throw new PortableAssetCompilationError(
      "Compiled AssetManifest/v1 is invalid",
      serializedManifest.diagnostics,
    );
  }
  const manifestBytes = serializedManifest.value;
  const descriptorBytes = new TextEncoder().encode(serializeTopikJson(resource));
  const contentBytes = new TextEncoder().encode(content);
  const inventory: TopikMaterializationFileInput[] = [
    { path: descriptorPath, type: "regular", mode: "100644", bytes: descriptorBytes },
    { path: contentPath, type: "regular", mode: "100644", bytes: contentBytes },
    ...paths.map((path) => ({
      path,
      type: "regular" as const,
      mode: "100644" as const,
      bytes: assetFiles.get(path)?.bytes ?? new Uint8Array(),
    })),
    {
      path: ASSET_MANIFEST_SIDECAR_PATH,
      type: "regular",
      mode: "100644",
      bytes: manifestBytes,
    },
  ];
  const snapshot = validatePortableAssetSnapshot({
    manifest,
    resource: manifest.resource,
    contents: [
      {
        path: contentPath,
        source: content,
        downloadableLinkPositions: [...downloadablePositions],
      },
    ],
    files: [...assetFiles.values()],
  });
  if (!snapshot.ok) {
    throw new PortableAssetCompilationError(
      "Compiled portable snapshot is invalid",
      snapshot.diagnostics,
    );
  }
  const semantic = createTopikAssetSemanticRecord(manifest, snapshot.value.occurrences);
  const materialization = createTopikMaterializationRecord(
    materializationDescriptors(resource),
    inventory,
    { contentPath },
  );
  return {
    assignments,
    retiredKeys,
    value: {
      resourceRoot,
      resource,
      manifest,
      manifestBytes,
      inventory,
      snapshot: snapshot.value,
      semantic,
      materialization,
    },
  };
}

function resolveCanonicalLocalReference(
  occurrence: TopikAssetOccurrence,
): { path: string; reference: string } | undefined {
  const syntax = validateTopikAssetReference(occurrence.reference);
  if (occurrence.reference !== occurrence.parsedReference && syntax.valid) {
    throw new PortableAssetCompilationError(
      "Content contains a parser-normalized asset reference",
      [
        topikAssetDiagnostic(
          syntax.kind === "external-https"
            ? "TOPIK_EXTERNAL_REFERENCE_UNSAFE"
            : "TOPIK_ASSET_PATH_INVALID",
          "Asset reference source spelling is not canonical",
          { location: { contentPosition: occurrence.position } },
        ),
      ],
    );
  }
  if (syntax.valid && syntax.kind === "external-https") return undefined;
  if (!syntax.valid) {
    const validation =
      syntax.failureKind === "external"
        ? validateTopikExternalAssetReference(occurrence.reference)
        : decodeTopikAssetReference(occurrence.reference);
    throw new PortableAssetCompilationError(
      "Content contains an invalid asset reference",
      validation.ok ? [] : validation.diagnostics,
    );
  }
  const decoded = decodeTopikAssetReference(occurrence.reference);
  if (!decoded.ok) {
    throw new PortableAssetCompilationError(
      "Local asset reference is not canonical",
      decoded.diagnostics,
    );
  }
  return { path: decoded.value, reference: occurrence.reference };
}

async function provePlainDownload(
  occurrence: TopikAssetOccurrence,
  input: CompileOneInput,
  assetFiles: Map<string, PortableAssetFileDescriptor & { bytes: Uint8Array }>,
): Promise<{ path: string; reference: string } | undefined> {
  const syntax = validateTopikAssetReference(occurrence.reference);
  if (!syntax.valid) {
    const parsedSyntax = validateTopikAssetReference(occurrence.parsedReference);
    if (!parsedSyntax.valid || parsedSyntax.kind !== "local") return undefined;
    const parsedPath = decodeTopikAssetReference(occurrence.parsedReference);
    if (!parsedPath.ok || input.resourceSourcePaths.has(parsedPath.value)) return undefined;
    const proven = await readPortableAssetFile({ root: input.rootDir, path: parsedPath.value });
    if (!proven.ok) {
      if (proven.diagnostics.every((diagnostic) => diagnostic.id === "TOPIK_ASSET_FILE_MISSING")) {
        return undefined;
      }
      throw new PortableAssetCompilationError(
        "Generic link target could not be proven as a portable download",
        proven.diagnostics,
      );
    }
    resolveCanonicalLocalReference(occurrence);
    throw new PortableAssetCompilationError("Invalid generic download reference was accepted");
  }
  if (syntax.kind !== "local") return undefined;
  const decoded = decodeTopikAssetReference(occurrence.reference);
  if (!decoded.ok || input.resourceSourcePaths.has(decoded.value)) return undefined;
  const read = await readPortableAssetFile({ root: input.rootDir, path: decoded.value });
  if (!read.ok || read.value.bytes === undefined) {
    if (read.diagnostics.every((diagnostic) => diagnostic.id === "TOPIK_ASSET_FILE_MISSING")) {
      return undefined;
    }
    throw new PortableAssetCompilationError(
      "Generic link target could not be proven as a portable download",
      read.diagnostics,
    );
  }
  assetFiles.set(decoded.value, read.value as PortableAssetFileDescriptor & { bytes: Uint8Array });
  return { path: decoded.value, reference: occurrence.reference };
}

interface MutableKeyState {
  version: typeof TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION;
  keysByResource: Map<string, Map<string, string>>;
  retiredKeysByResource: Map<string, Set<string>>;
}

function copyAndValidateState(input?: PortableAssetKeyStateV1): MutableKeyState {
  if (
    input !== undefined &&
    (!isPlainRecord(input) ||
      !Object.hasOwn(input, "version") ||
      input.version !== TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION ||
      !Object.hasOwn(input, "keysByResource") ||
      !isPlainRecord(input.keysByResource) ||
      !Object.hasOwn(input, "retiredKeysByResource") ||
      !isPlainRecord(input.retiredKeysByResource))
  ) {
    throw new PortableAssetCompilationError("Portable key state version is unsupported");
  }
  const keysByResource = new Map<string, Map<string, string>>();
  const retiredKeysByResource = new Map<string, Set<string>>();
  for (const [resource, assignments] of Object.entries(input?.keysByResource ?? {})) {
    if (!validateTopikPath(resource).ok || !isPlainRecord(assignments)) {
      throw new PortableAssetCompilationError("Portable key state is invalid or ambiguous");
    }
    const byPath = new Map<string, string>();
    const seen = new Set<string>();
    for (const [path, key] of Object.entries(assignments)) {
      if (!validateTopikPath(path).ok || !isTopikAssetKey(key) || seen.has(key)) {
        throw new PortableAssetCompilationError("Portable key state is invalid or ambiguous");
      }
      seen.add(key);
      byPath.set(path, key);
    }
    keysByResource.set(resource, byPath);
  }
  for (const [resource, retired] of Object.entries(input?.retiredKeysByResource ?? {})) {
    if (!validateTopikPath(resource).ok || !Array.isArray(retired)) {
      throw new PortableAssetCompilationError("Portable key state is invalid or ambiguous");
    }
    const seen = new Set(keysByResource.get(resource)?.values() ?? []);
    const retiredSet = new Set<string>();
    for (const key of retired) {
      if (typeof key !== "string" || !isTopikAssetKey(key) || seen.has(key)) {
        throw new PortableAssetCompilationError("Portable key state reuses an invalid retired key");
      }
      seen.add(key);
      retiredSet.add(key);
    }
    retiredKeysByResource.set(resource, retiredSet);
  }
  return { version: TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION, keysByResource, retiredKeysByResource };
}

function materializeKeyState(state: MutableKeyState): PortableAssetKeyStateV1 {
  const keysByResource: Record<string, Record<string, string>> = Object.create(null) as Record<
    string,
    Record<string, string>
  >;
  const retiredKeysByResource: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  const resourceKeys = new Set([
    ...state.keysByResource.keys(),
    ...state.retiredKeysByResource.keys(),
  ]);
  for (const resource of [...resourceKeys].sort(compareUtf8)) {
    const assignments: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [path, key] of [...(state.keysByResource.get(resource) ?? [])].sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      Object.defineProperty(assignments, path, {
        value: key,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    Object.defineProperty(keysByResource, resource, {
      value: assignments,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(retiredKeysByResource, resource, {
      value: [...(state.retiredKeysByResource.get(resource) ?? [])].sort(compareUtf8),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return {
    version: TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
    keysByResource,
    retiredKeysByResource,
  };
}

function readDownloadablePositions(
  input: Readonly<Record<string, readonly string[]>> | undefined,
  resourceKey: string,
): readonly string[] {
  if (input === undefined || !Object.hasOwn(input, resourceKey)) return [];
  const positions = input[resourceKey];
  if (!Array.isArray(positions) || positions.some((position) => typeof position !== "string")) {
    throw new PortableAssetCompilationError("Download position declarations are invalid");
  }
  return positions;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function replaceResourceContent<T extends ContentBearingResource>(resource: T, content: string): T {
  return {
    ...resource,
    spec: { ...resource.spec, content: { ...resource.spec.content, value: content } },
  } as T;
}

function isContentBearingResource(resource: Resource): resource is ContentBearingResource {
  return (
    resource.type === "Guide" || resource.type === "WikiPage" || resource.type === "CoursePage"
  );
}

function topikResourceKey(resource: Resource): string {
  return `${resource.type}/${resource.name}`;
}

function requirePath(value: string, message: string): string {
  const validation = validateTopikPath(value);
  if (!validation.ok) throw new PortableAssetCompilationError(message, validation.diagnostics);
  return validation.value.path;
}

function materializationDescriptors(resource: ContentBearingResource) {
  return {
    resourceApi: `${resource.type}/${resource.apiVersion}`,
    contentApi: "topik-content/0.1",
    contentSchema: "0.1.0",
    manifestApi: "AssetManifest/v1",
    pathRules: "topik-path-v1",
    referenceRules: "topik-asset-reference-v1",
    serializer: "topik-json-v1",
    materializer: "topik-materialization-v1" as const,
    mapping: "resource-root-v1",
    ownershipClassifier: "topik-assets-v1",
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

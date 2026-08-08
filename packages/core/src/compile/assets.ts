import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  extractTopikAssetOccurrences,
  rewriteTopikAssetOccurrences,
  type TopikAssetOccurrence,
} from "@topik/content-schema";
import type { AssetManifestV1, CoursePage, Guide, WikiPage } from "@topik/schema";
import type { Resource } from "../resource";
import { validateResources } from "../validate";
import { ASSET_MANIFEST_SIDECAR_PATH } from "../portable/constants";
import type { TopikAssetDiagnostic } from "../portable/diagnostics";
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
import { encodeTopikAssetReference } from "../portable/reference";
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
  /** Deleted keys remain unavailable across retries. */
  retiredKeys: readonly string[];
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
  const reservedKeys = new Set<string>();
  for (const assignments of Object.values(state.keysByResource)) {
    for (const key of Object.values(assignments)) reservedKeys.add(key);
  }
  for (const key of state.retiredKeys) reservedKeys.add(key);

  const seenResources = new Set<string>();
  const rewrittenResources: Resource[] = [];
  const artifacts: PortableResourceArtifact[] = [];
  const contentResourceKeys = new Set<string>();

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
    const artifact = await compileOneResource({
      resource,
      rootDir: input.rootDir,
      sourcePath: input.sourcePathsByResource[resourceKey],
      downloadableLinkPositions: input.downloadableLinkPositionsByResource?.[resourceKey] ?? [],
      assignments: state.keysByResource[resourceKey] ?? {},
      reservedKeys,
      retiredKeys: state.retiredKeys,
      randomBytes: input.randomBytes,
    });
    state.keysByResource[resourceKey] = artifact.assignments;
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
  return { resources: rewrittenResources, artifacts, keyState: state };
}

interface CompileOneInput {
  resource: ContentBearingResource;
  rootDir: string;
  sourcePath: string;
  downloadableLinkPositions: readonly string[];
  assignments: Readonly<Record<string, string>>;
  reservedKeys: Set<string>;
  retiredKeys: readonly string[];
  randomBytes?: (size: number) => Uint8Array;
}

async function compileOneResource(
  input: CompileOneInput,
): Promise<{ value: PortableResourceArtifact; assignments: Record<string, string> }> {
  const sourcePath = requirePath(input.sourcePath, "Content source path is not portable");
  const resourceRoot = requirePath(
    `${input.resource.type}/${input.resource.name}`,
    "Resource output root is not portable",
  );
  const descriptorPath = "resource.json";
  const contentPath = "content.topik";
  const extracted = extractTopikAssetOccurrences(input.resource.spec.content.value, {
    downloadableLinkPositions: input.downloadableLinkPositions,
  });
  const localByPosition = new Map<string, { path: string; reference: string }>();
  for (const occurrence of extracted) {
    if (occurrence.kind === "external-https") continue;
    if (occurrence.kind === "unsafe") {
      throw new PortableAssetCompilationError("Content contains an unsafe asset reference");
    }
    const resolved = resolveLocalReference(occurrence, sourcePath);
    localByPosition.set(occurrence.position, resolved);
  }
  const rewrittenContent =
    localByPosition.size === 0
      ? input.resource.spec.content.value
      : rewriteTopikAssetOccurrences(
          input.resource.spec.content.value,
          (occurrence) => localByPosition.get(occurrence.position)?.reference,
          { downloadableLinkPositions: input.downloadableLinkPositions },
        );

  const assignments = { ...input.assignments };
  const assetFiles = new Map<string, PortableAssetFileDescriptor & { bytes: Uint8Array }>();
  const assets: AssetManifestV1["assets"] = {};
  const paths = [...new Set([...localByPosition.values()].map((entry) => entry.path))].sort(
    compareUtf8,
  );
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
    const persistedKey = assignments[path];
    const generated = generateTopikAssetKey({
      ...(persistedKey === undefined ? {} : { persistedKey }),
      randomBytes: input.randomBytes,
      reservedKeys: input.reservedKeys,
      retiredKeys: input.retiredKeys,
    });
    if (!generated.ok) {
      throw new PortableAssetCompilationError(
        "Portable asset key allocation failed",
        generated.diagnostics,
      );
    }
    const key = generated.value;
    const existingAssignment = Object.entries(assignments).find(
      ([otherPath, otherKey]) => otherPath !== path && otherKey === key,
    );
    if (
      existingAssignment !== undefined ||
      (persistedKey === undefined && input.reservedKeys.has(key))
    ) {
      throw new PortableAssetCompilationError("Portable key state assigns one key more than once");
    }
    assignments[path] = key;
    input.reservedKeys.add(key);

    const read = await readPortableAssetFile({ root: input.rootDir, path });
    if (!read.ok || read.value.bytes === undefined) {
      throw new PortableAssetCompilationError(
        "Portable asset bytes could not be proven",
        read.diagnostics,
      );
    }
    const file = read.value as PortableAssetFileDescriptor & { bytes: Uint8Array };
    assetFiles.set(path, file);
    assets[key] = {
      digest: { algorithm: "sha256", value: sha256(file.bytes) },
      mediaType: sniffPortableMediaType(file.bytes),
      path,
      size: file.bytes.byteLength,
    };
  }

  const resource = replaceResourceContent(input.resource, rewrittenContent);
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
  const contentBytes = new TextEncoder().encode(rewrittenContent);
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
        source: rewrittenContent,
        downloadableLinkPositions: input.downloadableLinkPositions,
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

function resolveLocalReference(
  occurrence: TopikAssetOccurrence,
  sourcePath: string,
): { path: string; reference: string } {
  if (
    occurrence.reference.startsWith("/") ||
    occurrence.reference.includes("?") ||
    occurrence.reference.includes("#")
  ) {
    throw new PortableAssetCompilationError("Local asset references must be canonical paths");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(occurrence.reference);
  } catch {
    throw new PortableAssetCompilationError("Local asset reference encoding is invalid");
  }
  const fileRelative = decoded.startsWith("./") || decoded.startsWith("../");
  const resolved = fileRelative
    ? posix.normalize(posix.join(posix.dirname(sourcePath), decoded))
    : decoded;
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) {
    throw new PortableAssetCompilationError("Local asset reference escapes its resource root");
  }
  const path = requirePath(resolved, "Local asset reference is not a portable path");
  const encoded = encodeTopikAssetReference(path);
  if (!encoded.ok) {
    throw new PortableAssetCompilationError(
      "Local asset reference cannot be canonicalized",
      encoded.diagnostics,
    );
  }
  return { path, reference: encoded.value };
}

function copyAndValidateState(input?: PortableAssetKeyStateV1): {
  version: typeof TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION;
  keysByResource: Record<string, Record<string, string>>;
  retiredKeys: string[];
} {
  if (
    input !== undefined &&
    (!isPlainRecord(input) ||
      !Object.hasOwn(input, "version") ||
      input.version !== TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION ||
      !Object.hasOwn(input, "keysByResource") ||
      !isPlainRecord(input.keysByResource) ||
      !Object.hasOwn(input, "retiredKeys") ||
      !Array.isArray(input.retiredKeys))
  ) {
    throw new PortableAssetCompilationError("Portable key state version is unsupported");
  }
  const keysByResource: Record<string, Record<string, string>> = {};
  const seen = new Set<string>();
  for (const [resource, assignments] of Object.entries(input?.keysByResource ?? {})) {
    if (!isPlainRecord(assignments)) {
      throw new PortableAssetCompilationError("Portable key state is invalid or ambiguous");
    }
    keysByResource[resource] = {};
    for (const [path, key] of Object.entries(assignments)) {
      if (!validateTopikPath(path).ok || !isTopikAssetKey(key) || seen.has(key)) {
        throw new PortableAssetCompilationError("Portable key state is invalid or ambiguous");
      }
      seen.add(key);
      keysByResource[resource][path] = key;
    }
  }
  const retiredKeys = [...(input?.retiredKeys ?? [])];
  for (const key of retiredKeys) {
    if (!isTopikAssetKey(key) || seen.has(key)) {
      throw new PortableAssetCompilationError("Portable key state reuses an invalid retired key");
    }
    seen.add(key);
  }
  return { version: TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION, keysByResource, retiredKeys };
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

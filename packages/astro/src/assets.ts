import { type AssetCompilationResult, type AssetPayload, type CompiledAsset } from "@topik/core";
import type { Loader } from "astro/loaders";

interface TopikAssetSnapshot {
  assets: readonly CompiledAsset[];
  assetsByName: ReadonlyMap<string, CompiledAsset>;
  payloadsByPath: ReadonlyMap<string, AssetPayload>;
}

interface TopikAssetLoaderIdentity {
  kind: "guides" | "wiki";
  name: string;
  sourceRoot: string;
}

interface LogicalTopikAssetSnapshot {
  current: TopikAssetSnapshot;
  identity: Readonly<TopikAssetLoaderIdentity>;
  compilation: Promise<unknown>;
  sourceOwners: Map<string, SourceAssetSnapshot>;
}

interface SourceAssetSnapshot {
  current: TopikAssetSnapshot;
  dispose(): void;
  isActive(): boolean;
}

interface TopikAssetAccess {
  /** Current compiler-emitted independent Asset descriptors. */
  getAssets(): readonly CompiledAsset[];
  /** Resolve a compiler-generated Asset name to its canonical digest URL. */
  resolveAsset(name: string): string | undefined;
}

export type TopikAssetLoader = Loader & TopikAssetAccess;

interface TopikAssetPublication {
  clear(): void;
  publish(result: Pick<AssetCompilationResult, "payloads" | "resources">): void;
}

export interface TopikAssetSnapshotControl extends TopikAssetPublication {
  forSource(owner: string, dispose: () => void, isActive: () => boolean): TopikAssetPublication;
}

type TopikAssetCompiler = () => Promise<AssetCompilationResult>;

interface RegisteredTopikAssetLoader {
  compile: TopikAssetCompiler;
  logicalSnapshot: LogicalTopikAssetSnapshot;
  snapshot: TopikAssetSnapshotControl;
}

const EMPTY_SNAPSHOT: TopikAssetSnapshot = {
  assets: Object.freeze([]),
  assetsByName: new Map(),
  payloadsByPath: new Map(),
};
const RUNTIME_ASSET_URLS = Symbol.for("@topik/astro/runtime-asset-urls");
// Astro may evaluate configuration and content loaders in separate module graphs.
// A global symbol bridges only their process-local, logically keyed current snapshots.
const LOGICAL_ASSET_SNAPSHOTS = Symbol.for("@topik/astro/logical-asset-snapshots/v4");
const registeredLoaders = new WeakMap<object, RegisteredTopikAssetLoader>();

export function requireTopikLoaderName(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Topik loader name must be nonblank");
  }
  return value;
}

export function withTopikAssetSnapshot<T extends Loader>(
  loader: T,
  compile: TopikAssetCompiler,
  identity: TopikAssetLoaderIdentity,
): { loader: T & TopikAssetAccess; snapshot: TopikAssetSnapshotControl } {
  const logicalSnapshot = getLogicalSnapshot(identity);
  const snapshot: TopikAssetSnapshotControl = {
    clear() {
      for (const source of logicalSnapshot.sourceOwners.values()) source.dispose();
      logicalSnapshot.sourceOwners.clear();
      logicalSnapshot.current = EMPTY_SNAPSHOT;
    },
    publish(result) {
      logicalSnapshot.current = createSnapshot(result);
    },
    forSource(owner, dispose, isActive) {
      const previous = logicalSnapshot.sourceOwners.get(owner);
      previous?.dispose();
      const source = { current: previous?.current ?? EMPTY_SNAPSHOT, dispose, isActive };
      logicalSnapshot.sourceOwners.set(owner, source);
      return {
        clear() {
          if (logicalSnapshot.sourceOwners.get(owner) !== source) return;
          source.current = EMPTY_SNAPSHOT;
          refreshSourceSnapshot(logicalSnapshot);
        },
        publish(result) {
          if (logicalSnapshot.sourceOwners.get(owner) !== source) return;
          source.current = createSnapshot(result);
          // Resolve names using the latest successful publication, while keeping
          // digest payloads referenced by every other active collection.
          logicalSnapshot.sourceOwners.delete(owner);
          logicalSnapshot.sourceOwners.set(owner, source);
          refreshSourceSnapshot(logicalSnapshot);
        },
      };
    },
  };
  const enhanced = Object.assign(loader, {
    getAssets: () => currentSnapshot(logicalSnapshot).assets,
    resolveAsset: (name: string) => {
      const asset = currentSnapshot(logicalSnapshot).assetsByName.get(name);
      return asset === undefined ? runtimeAssetUrls()?.get(name) : `/${asset.spec.uri}`;
    },
  });
  registeredLoaders.set(enhanced, { compile, logicalSnapshot, snapshot });
  return { loader: enhanced, snapshot };
}

export function assertTopikAssetLoaders(
  loaders: readonly TopikAssetLoader[],
): asserts loaders is readonly TopikAssetLoader[] {
  if (loaders.some((loader) => !registeredLoaders.has(loader))) {
    throw new TypeError("Topik Asset delivery accepts only loaders created by @topik/astro");
  }
}

export function findTopikAssetPayload(
  loaders: readonly TopikAssetLoader[],
  path: string,
): AssetPayload | undefined {
  for (const loader of loaders) {
    const registered = registeredLoaders.get(loader);
    const payload =
      registered && currentSnapshot(registered.logicalSnapshot).payloadsByPath.get(path);
    if (payload !== undefined) return payload;
  }
  return undefined;
}

export async function compileTopikAssetLoader(
  loader: TopikAssetLoader,
): Promise<AssetCompilationResult> {
  const registered = registeredLoaders.get(loader);
  if (registered === undefined) {
    throw new TypeError("Topik Asset compilation accepts only loaders created by @topik/astro");
  }
  // Equivalent loaders can live in different Astro module graphs. Serialize
  // their compilation through the same logical identity, including reloads.
  const compilation = registered.logicalSnapshot.compilation.then(registered.compile);
  registered.logicalSnapshot.compilation = compilation.then(
    () => {},
    () => {},
  );
  return compilation;
}

/** Compile and publish a complete multi-loader snapshot without exposing partial results. */
export async function refreshTopikAssetSnapshots(
  loaders: readonly TopikAssetLoader[],
): Promise<void> {
  assertTopikAssetLoaders(loaders);
  const registered = loaders.map((loader) => registeredLoaders.get(loader)!);
  for (const entry of registered) entry.snapshot.clear();
  try {
    const results = await Promise.all(loaders.map(compileTopikAssetLoader));
    for (let index = 0; index < registered.length; index++) {
      registered[index].snapshot.publish(results[index]);
    }
  } catch (error) {
    for (const entry of registered) entry.snapshot.clear();
    throw error;
  }
}

/** Return one immutable payload per canonical digest path across all loaders. */
export function collectTopikAssetPayloads(
  loaders: readonly TopikAssetLoader[],
): readonly AssetPayload[] {
  assertTopikAssetLoaders(loaders);
  const payloads = new Map<string, AssetPayload>();
  for (const loader of loaders) {
    for (const payload of currentSnapshot(
      registeredLoaders.get(loader)!.logicalSnapshot,
    ).payloadsByPath.values()) {
      const prior = payloads.get(payload.path);
      if (prior === undefined) {
        payloads.set(payload.path, payload);
        continue;
      }
      if (
        prior.integrity !== payload.integrity ||
        prior.mediaType !== payload.mediaType ||
        prior.size !== payload.size ||
        !equalBytes(prior.bytes, payload.bytes)
      ) {
        throw new TypeError("Topik loaders produced conflicting payloads for one digest path");
      }
    }
  }
  return [...payloads.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function collectTopikAssetUrls(
  loaders: readonly TopikAssetLoader[],
): ReadonlyMap<string, string> {
  assertTopikAssetLoaders(loaders);
  const urls = new Map<string, string>();
  for (const loader of loaders) {
    for (const asset of currentSnapshot(registeredLoaders.get(loader)!.logicalSnapshot).assets) {
      const url = `/${asset.spec.uri}`;
      const prior = urls.get(asset.name);
      if (prior !== undefined && prior !== url) {
        throw new TypeError("Topik loaders produced conflicting URLs for one Asset name");
      }
      urls.set(asset.name, url);
    }
  }
  return urls;
}

function getLogicalSnapshot(identity: TopikAssetLoaderIdentity): LogicalTopikAssetSnapshot {
  const registry = logicalSnapshotRegistry();
  const key = JSON.stringify([identity.kind, identity.sourceRoot, identity.name]);
  const existing = registry.get(key);
  if (existing !== undefined) {
    if (
      existing.identity.kind !== identity.kind ||
      existing.identity.sourceRoot !== identity.sourceRoot ||
      existing.identity.name !== identity.name
    ) {
      throw new TypeError("Topik Asset loader identity collision");
    }
    return existing;
  }
  const created = {
    current: EMPTY_SNAPSHOT,
    identity: Object.freeze({ ...identity }),
    compilation: Promise.resolve(),
    sourceOwners: new Map(),
  };
  registry.set(key, created);
  return created;
}

function currentSnapshot(logical: LogicalTopikAssetSnapshot): TopikAssetSnapshot {
  if ([...logical.sourceOwners.values()].some((source) => !source.isActive())) {
    refreshSourceSnapshot(logical);
  }
  return logical.current;
}

function refreshSourceSnapshot(logical: LogicalTopikAssetSnapshot): void {
  const assetsByName = new Map<string, CompiledAsset>();
  const payloadsByPath = new Map<string, AssetPayload>();
  for (const [owner, source] of logical.sourceOwners) {
    if (!source.isActive()) {
      logical.sourceOwners.delete(owner);
      source.dispose();
      continue;
    }
    for (const asset of source.current.assets) assetsByName.set(asset.name, asset);
    for (const [path, payload] of source.current.payloadsByPath) payloadsByPath.set(path, payload);
  }
  logical.current = {
    assets: Object.freeze([...assetsByName.values()]),
    assetsByName,
    payloadsByPath,
  };
}

function logicalSnapshotRegistry(): Map<string, LogicalTopikAssetSnapshot> {
  const runtime = globalThis as typeof globalThis & {
    [LOGICAL_ASSET_SNAPSHOTS]?: Map<string, LogicalTopikAssetSnapshot>;
  };
  return (runtime[LOGICAL_ASSET_SNAPSHOTS] ??= new Map());
}

function createSnapshot(
  result: Pick<AssetCompilationResult, "payloads" | "resources">,
): TopikAssetSnapshot {
  const assets = result.resources
    .filter((resource): resource is CompiledAsset => resource.type === "Asset")
    .map((asset) => Object.freeze({ ...asset, spec: Object.freeze({ ...asset.spec }) }));
  const payloads = result.payloads.map((payload) =>
    Object.freeze({
      ...payload,
      bytes: Uint8Array.from(payload.bytes),
      assetNames: Object.freeze([...payload.assetNames]),
    }),
  );
  return {
    assets: Object.freeze(assets),
    assetsByName: new Map(assets.map((asset) => [asset.name, asset])),
    payloadsByPath: new Map(payloads.map((payload) => [payload.path, payload])),
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function runtimeAssetUrls(): ReadonlyMap<string, string> | undefined {
  return (globalThis as typeof globalThis & { [RUNTIME_ASSET_URLS]?: ReadonlyMap<string, string> })[
    RUNTIME_ASSET_URLS
  ];
}

import {
  validateStableSourceNamespace,
  type AssetCompilationResult,
  type AssetPayload,
} from "@topik/core";
import type { Asset } from "@topik/schema";
import type { Loader } from "astro/loaders";

interface TopikAssetSnapshot {
  assets: readonly Asset[];
  assetsByName: ReadonlyMap<string, Asset>;
  payloadsByPath: ReadonlyMap<string, AssetPayload>;
}

interface TopikAssetAccess {
  /** Current compiler-emitted independent Asset descriptors. */
  getAssets(): readonly Asset[];
  /** Resolve a compiler-generated Asset name to its canonical digest URL. */
  resolveAsset(name: string): string | undefined;
}

export type TopikAssetLoader = Loader & TopikAssetAccess;

export interface TopikAssetSnapshotControl {
  clear(): void;
  publish(result: Pick<AssetCompilationResult, "payloads" | "resources">): void;
}

type TopikAssetCompiler = () => Promise<AssetCompilationResult>;

interface RegisteredTopikAssetLoader {
  compile: TopikAssetCompiler;
  getSnapshot: () => TopikAssetSnapshot;
  snapshot: TopikAssetSnapshotControl;
}

const EMPTY_SNAPSHOT: TopikAssetSnapshot = {
  assets: Object.freeze([]),
  assetsByName: new Map(),
  payloadsByPath: new Map(),
};
const RUNTIME_ASSET_URLS = Symbol.for("@topik/astro/runtime-asset-urls");
const snapshots = new WeakMap<object, RegisteredTopikAssetLoader>();

export function requireTopikSourceNamespace(value: string): string {
  const validated = validateStableSourceNamespace(value);
  if (!validated.ok) throw new TypeError("Topik Asset source namespace is not portable text");
  return validated.value;
}

export function withTopikAssetSnapshot<T extends Loader>(
  loader: T,
  compile: TopikAssetCompiler,
): { loader: T & TopikAssetAccess; snapshot: TopikAssetSnapshotControl } {
  let current = EMPTY_SNAPSHOT;
  const snapshot: TopikAssetSnapshotControl = {
    clear() {
      current = EMPTY_SNAPSHOT;
    },
    publish(result) {
      current = createSnapshot(result);
    },
  };
  const enhanced = Object.assign(loader, {
    getAssets: () => current.assets,
    resolveAsset: (name: string) => {
      const asset = current.assetsByName.get(name);
      return asset === undefined ? runtimeAssetUrls()?.get(name) : `/${asset.spec.uri}`;
    },
  });
  snapshots.set(enhanced, { compile, getSnapshot: () => current, snapshot });
  return { loader: enhanced, snapshot };
}

export function assertTopikAssetLoaders(
  loaders: readonly TopikAssetLoader[],
): asserts loaders is readonly TopikAssetLoader[] {
  if (loaders.some((loader) => !snapshots.has(loader))) {
    throw new TypeError("Topik Asset delivery accepts only loaders created by @topik/astro");
  }
}

export function findTopikAssetPayload(
  loaders: readonly TopikAssetLoader[],
  path: string,
): AssetPayload | undefined {
  for (const loader of loaders) {
    const payload = snapshots.get(loader)?.getSnapshot().payloadsByPath.get(path);
    if (payload !== undefined) return payload;
  }
  return undefined;
}

export async function compileTopikAssetLoader(
  loader: TopikAssetLoader,
): Promise<AssetCompilationResult> {
  const registered = snapshots.get(loader);
  if (registered === undefined) {
    throw new TypeError("Topik Asset compilation accepts only loaders created by @topik/astro");
  }
  return registered.compile();
}

/** Compile and publish a complete multi-loader snapshot without exposing partial results. */
export async function refreshTopikAssetSnapshots(
  loaders: readonly TopikAssetLoader[],
): Promise<void> {
  assertTopikAssetLoaders(loaders);
  const registered = loaders.map((loader) => snapshots.get(loader)!);
  for (const entry of registered) entry.snapshot.clear();
  try {
    const results = await Promise.all(registered.map((entry) => entry.compile()));
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
    for (const payload of snapshots.get(loader)!.getSnapshot().payloadsByPath.values()) {
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
    for (const asset of snapshots.get(loader)!.getSnapshot().assets) {
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

function createSnapshot(
  result: Pick<AssetCompilationResult, "payloads" | "resources">,
): TopikAssetSnapshot {
  const assets = result.resources
    .filter((resource): resource is Asset => resource.type === "Asset")
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

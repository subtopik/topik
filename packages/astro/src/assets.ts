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

const EMPTY_SNAPSHOT: TopikAssetSnapshot = {
  assets: Object.freeze([]),
  assetsByName: new Map(),
  payloadsByPath: new Map(),
};
const snapshots = new WeakMap<object, () => TopikAssetSnapshot>();

export function requireTopikSourceNamespace(value: string): string {
  const validated = validateStableSourceNamespace(value);
  if (!validated.ok) throw new TypeError("Topik Asset source namespace is not portable text");
  return validated.value;
}

export function withTopikAssetSnapshot<T extends Loader>(
  loader: T,
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
      return asset === undefined ? undefined : `/${asset.spec.uri}`;
    },
  });
  snapshots.set(enhanced, () => current);
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
    const payload = snapshots.get(loader)?.().payloadsByPath.get(path);
    if (payload !== undefined) return payload;
  }
  return undefined;
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

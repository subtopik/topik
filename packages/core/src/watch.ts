import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { watch as chokidarWatch } from "chokidar";
import { compile } from "./compile";
import type { AssetCompilationOptions, AssetPayload } from "./compile/assets";
import { digestTopikMaterializationRecord } from "./portable/identity";
import type { Resource } from "./resource";

export interface WatchOptions {
  dir: string;
  signal?: AbortSignal;
  assets?: AssetCompilationOptions;
}

export type UpdateListener = (key: string, resource: Resource) => void;
export type ErrorListener = (error: Error) => void;

export interface Watcher {
  /** Current compiled resources, keyed by `Type/name`. */
  resources: Map<string, Resource>;
  /** Current deduplicated local payloads, keyed by compilation-relative output path. */
  payloads: Map<string, AssetPayload>;
  on(event: "update", listener: UpdateListener): this;
  on(event: "error", listener: ErrorListener): this;
  off(event: "update", listener: UpdateListener): this;
  off(event: "error", listener: ErrorListener): this;
  close(): Promise<void>;
}

function resourceKey(resource: Resource): string {
  return `${resource.type}/${resource.name}`;
}

export async function watch(options: WatchOptions): Promise<Watcher> {
  const dir = resolve(options.dir);
  const emitter = new EventEmitter();
  const resources = new Map<string, Resource>();
  const payloads = new Map<string, AssetPayload>();

  // Initial compile
  const initial = await compile({ dir, assets: options.assets });
  let materialization = initial.materialization;
  for (const resource of initial.resources) {
    resources.set(resourceKey(resource), resource);
  }
  for (const payload of initial.payloads) payloads.set(payload.path, payload);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function recompile() {
    try {
      const result = await compile({ dir, assets: options.assets });
      const newKeys = new Set<string>();
      const materializationChanged =
        digestTopikMaterializationRecord(materialization) !==
        digestTopikMaterializationRecord(result.materialization);
      materialization = result.materialization;
      payloads.clear();
      for (const payload of result.payloads) payloads.set(payload.path, payload);

      for (const resource of result.resources) {
        const key = resourceKey(resource);
        newKeys.add(key);

        const existing = resources.get(key);
        const resourceChanged = !existing || JSON.stringify(existing) !== JSON.stringify(resource);
        resources.set(key, resource);
        if (resourceChanged || (resource.type === "Asset" && materializationChanged)) {
          emitter.emit("update", key, resource);
        }
      }

      // Remove resources that no longer exist
      for (const key of resources.keys()) {
        if (!newKeys.has(key)) {
          resources.delete(key);
        }
      }
    } catch (error) {
      emitter.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  function scheduleRecompile() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recompile, 100);
  }

  const fsWatcher = chokidarWatch(dir, {
    ignoreInitial: true,
    ignored: [/(^|[/\\])(?:\.git|\.topik)(?:[/\\]|$)/, "**/node_modules/**"],
  });

  fsWatcher.on("add", scheduleRecompile);
  fsWatcher.on("change", scheduleRecompile);
  fsWatcher.on("unlink", scheduleRecompile);

  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      void fsWatcher.close();
    });
  }

  const watcher = {
    resources,
    payloads,
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener);
      return watcher;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      emitter.off(event, listener);
      return watcher;
    },
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      await fsWatcher.close();
    },
  };

  return watcher as Watcher;
}

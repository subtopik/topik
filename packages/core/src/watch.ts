import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { watch as chokidarWatch } from "chokidar";
import { compile } from "./compile";
import type { Resource } from "./resource";

export interface WatchOptions {
  dir: string;
  signal?: AbortSignal;
}

export type UpdateListener = (key: string, resource: Resource) => void;
export type ErrorListener = (error: Error) => void;

export interface Watcher {
  /** Current compiled resources, keyed by `Type/name`. */
  resources: Map<string, Resource>;
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

  // Initial compile
  const initial = await compile({ dir });
  for (const resource of initial.resources) {
    resources.set(resourceKey(resource), resource);
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function recompile() {
    try {
      const result = await compile({ dir });
      const newKeys = new Set<string>();

      for (const resource of result.resources) {
        const key = resourceKey(resource);
        newKeys.add(key);

        const existing = resources.get(key);
        const serialized = JSON.stringify(resource);
        if (!existing || JSON.stringify(existing) !== serialized) {
          resources.set(key, resource);
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
    ignored: [
      /(^|[/\\])\../, // dotfiles
      "**/node_modules/**",
    ],
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

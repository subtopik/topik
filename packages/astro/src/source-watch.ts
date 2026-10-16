import { isAbsolute, relative, sep } from "node:path";
import type { AssetCompilationResult } from "@topik/core";
import type { LoaderContext } from "astro/loaders";
import type { TopikAssetSnapshotControl } from "./assets";

/** Keep content entries and their Asset payloads on the same completed compilation. */
export async function loadTopikSource(
  root: string,
  context: LoaderContext,
  snapshot: TopikAssetSnapshotControl,
  compile: () => Promise<AssetCompilationResult>,
  publishEntries: (compiled: AssetCompilationResult) => void,
): Promise<void> {
  let active = true;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const watcher = context.watcher;

  function dispose() {
    active = false;
    clearTimeout(timer);
    watcher?.off("all", onChange);
  }
  function onChange(event: string, path: string) {
    if (!active || !["add", "change", "unlink", "addDir", "unlinkDir"].includes(event)) return;
    const local = relative(root, path);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) return;
    if (local.split(sep).some((part) => part === ".git" || part === "node_modules")) return;
    revision++;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void refresh().catch((error) =>
        context.logger.error(`Topik source refresh failed: ${String(error)}`),
      );
    }, 50);
  }
  async function run() {
    while (active) {
      const started = revision;
      try {
        const compiled = await compile();
        if (!active) return;
        if (started !== revision) continue;
        // Commit the loader store and its payload snapshot in one synchronous turn.
        publishEntries(compiled);
        snapshot.publish(compiled);
        return;
      } catch (error) {
        if (!active) return;
        if (started !== revision) continue;
        context.store.clear();
        snapshot.clear();
        throw error;
      }
    }
  }
  async function refresh() {
    if (running) return running;
    clearTimeout(timer);
    running = run();
    try {
      await running;
    } finally {
      clearTimeout(timer);
      running = undefined;
    }
  }

  snapshot.replaceSourceWatcher(dispose);
  watcher?.on("all", onChange);
  watcher?.add(root);
  await refresh();
}

import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  const generatedDirectories: string[] = [];
  if (context.config?.root) {
    generatedDirectories.push(fileURLToPath(new URL(".astro/", context.config.root)));
  }
  if (context.config?.cacheDir) generatedDirectories.push(fileURLToPath(context.config.cacheDir));

  function dispose() {
    active = false;
    clearTimeout(timer);
    watcher?.off("all", onChange);
  }
  function isActive() {
    if (active && watcher && !watcher.listeners("all").includes(onChange)) dispose();
    return active;
  }
  function onChange(event: string, path: string) {
    if (!active || !["add", "change", "unlink", "addDir", "unlinkDir"].includes(event)) return;
    // Publishing entries writes Astro's generated files; do not feed those writes back
    // into compilation or alter the shared watcher's behavior for other consumers.
    if (generatedDirectories.some((directory) => containsPath(directory, path))) return;
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
    while (isActive()) {
      const started = revision;
      try {
        const compiled = await compile();
        if (!isActive()) return;
        if (started !== revision) continue;
        // Commit the loader store and its payload snapshot in one synchronous turn.
        publishEntries(compiled);
        snapshot.publish(compiled);
        return;
      } catch (error) {
        if (!isActive()) return;
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

  const owner = JSON.stringify([context.config?.root?.href, context.collection]);
  snapshot.replaceSourceWatcher(owner, dispose);
  watcher?.on("all", onChange);
  watcher?.add(root);
  await refresh();
}

function containsPath(directory: string, path: string): boolean {
  const local = relative(directory, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

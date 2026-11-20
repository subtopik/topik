import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { relative, resolve } from "node:path";
import { watch as chokidarWatch } from "chokidar";
import { compile, type CompileValidationOptions } from "./compile";
import type { AssetPayload } from "./compile/assets";
import { validateGitExecutableOption, type FileSafety } from "./assets/files";
import { createContentMemo } from "./compile/content-memo";
import type { Resource } from "./resource";
import { TOPIK_PREVIEW_PROTOCOL, type PreviewState } from "./preview";
import {
  previewErrorDiagnostics,
  previewResultDiagnostics,
  type ResourcesByPath,
} from "./watch-diagnostics";

export type UpdateListener = (key: string, resource: Resource) => void;
export type ErrorListener = (error: Error) => void;
export interface WatchOptions {
  dir: string;
  signal?: AbortSignal;
  /** Validation options passed to every compilation, for example the link policy. */
  validation?: CompileValidationOptions;
  /** File read safety passed to every compilation; see `CompileOptions.fileSafety`. */
  fileSafety?: FileSafety;
  /** Git executable passed to every compilation; see `CompileOptions.gitExecutable`. */
  gitExecutable?: string;
  /**
   * Milliseconds without filesystem notifications before a recompilation starts: an integer
   * from 0 to 2147483647 (the `setTimeout` maximum). Defaults to
   * {@link DEFAULT_WATCH_DEBOUNCE_MS}. An invalid value rejects with a `RangeError`.
   */
  debounceMs?: number;
  /**
   * Receives every compile and watch error, including one from the initial compilation
   * that completes before `watch()` resolves and so before `on("error")` can be called.
   */
  onError?: ErrorListener;
}
export type PreviewStateListener = (state: PreviewState) => void;
export interface Watcher {
  /** Compatibility inventory; replaced completely before any success notification. */
  resources: Map<string, Resource>;
  payloads: Map<string, AssetPayload>;
  /** Immutable, complete authoritative state. Treat resources/order/payloads as one commit. */
  readonly state: PreviewState;
  on(event: "preview-state", listener: PreviewStateListener): this;
  on(event: "update", listener: UpdateListener): this;
  on(event: "error", listener: ErrorListener): this;
  off(event: "preview-state", listener: PreviewStateListener): this;
  off(event: "update", listener: UpdateListener): this;
  off(event: "error", listener: ErrorListener): this;
  close(): Promise<void>;
}

const IGNORED_SEGMENT =
  /(^|[/\\])(?:node_modules|\.git|\.topik(?:-compilation-(?:generation|prior)-[^/\\]+)?)(?:[/\\]|$)/;

/** Default quiet period that coalesces bursts of filesystem notifications into one compile. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 100;
/** Largest delay `setTimeout` honours; longer delays fire immediately instead. */
const MAX_WATCH_DEBOUNCE_MS = 2 ** 31 - 1;

function watchDebounceMs(value: unknown): number {
  if (value === undefined) return DEFAULT_WATCH_DEBOUNCE_MS;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_WATCH_DEBOUNCE_MS
  ) {
    throw new RangeError(
      `Watch debounceMs must be an integer from 0 to ${MAX_WATCH_DEBOUNCE_MS} milliseconds`,
    );
  }
  return value;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function watch(options: WatchOptions): Promise<Watcher> {
  const dir = resolve(options.dir);
  const debounceMs = watchDebounceMs(options.debounceMs);
  // Fail before watching rather than on every compilation.
  validateGitExecutableOption(options.gitExecutable);
  const emitter = new EventEmitter();
  // Every connected preview client listens, so the default limit of 10 is not a leak signal.
  emitter.setMaxListeners(0);
  if (options.onError) emitter.on("error", options.onError);
  const resources = new Map<string, Resource>();
  const payloads = new Map<string, AssetPayload>();
  let state: PreviewState = freeze({
    protocol: TOPIK_PREVIEW_PROTOCOL,
    sessionId: randomUUID(),
    sequence: 0,
    generation: null,
    status: "compiling",
    diagnostics: [],
    resources: [],
    payloads: [],
  });
  // The payload entries each Asset owns, so an Asset updates only when its own bytes or path do.
  let assetPayloads = new Map<string, string>();
  // Unchanged documents are not parsed and validated again on the next compilation.
  const contentMemo = createContentMemo();
  let requested = 0;
  let closed = false;
  let watchFailed = false;
  let running: Promise<void> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Public listeners are external code: a throwing listener must not change compile
  // state, skip other listeners, or escape into the compile loop or chokidar.
  function reportError(error: unknown, fallback: string) {
    const reported = error instanceof Error ? error : new Error(fallback);
    for (const listener of emitter.listeners("error")) {
      try {
        listener(reported);
      } catch {
        // An error listener has no further reporting channel; never recurse.
      }
    }
  }
  function dispatch(event: "preview-state" | "update", ...args: unknown[]) {
    for (const listener of emitter.listeners(event)) {
      try {
        listener(...args);
      } catch (error) {
        reportError(error, "Watcher listener failed");
      }
    }
  }
  // Diagnostics name the resource whose source they are in, from the last success.
  let resourcesByPath: ResourcesByPath = new Map();
  function publish(patch: Partial<PreviewState>) {
    const { omittedDiagnostics: _previous, ...rest } = state;
    const next: PreviewState = { ...rest, ...patch, sequence: state.sequence + 1 };
    if (next.omittedDiagnostics === undefined) delete next.omittedDiagnostics;
    state = freeze(next);
    dispatch("preview-state", state);
  }

  async function drain() {
    do {
      const revision = requested;
      publish({ status: "compiling", diagnostics: [] });
      try {
        let result;
        try {
          result = await compile({
            dir,
            validation: options.validation,
            fileSafety: options.fileSafety,
            gitExecutable: options.gitExecutable,
            contentMemo,
          });
        } finally {
          // Keep what this compilation read for the next; drop what it no longer needs.
          contentMemo.prune();
        }
        // An edit arrived while reading: discard this candidate, including its payloads.
        if (closed || watchFailed) return;
        if (revision !== requested) continue;
        const nextAssetPayloads = new Map<string, string>();
        for (const payload of result.materialization.payloads)
          for (const name of payload.assetNames)
            nextAssetPayloads.set(
              name,
              `${nextAssetPayloads.get(name) ?? ""}${payload.path}\0${payload.sha256}\0`,
            );
        const updates = result.resources.filter((resource) => {
          const existing = resources.get(`${resource.type}/${resource.name}`);
          return (
            JSON.stringify(existing) !== JSON.stringify(resource) ||
            (resource.type === "Asset" &&
              assetPayloads.get(resource.name) !== nextAssetPayloads.get(resource.name))
          );
        });
        assetPayloads = nextAssetPayloads;
        resources.clear();
        payloads.clear();
        for (const resource of result.resources)
          resources.set(`${resource.type}/${resource.name}`, resource);
        for (const payload of result.payloads) payloads.set(payload.path, payload);
        const paths = new Map<string, { type: string; name: string }>();
        for (const source of result.provenance ?? [])
          for (const [key, path] of Object.entries(source.sourcePathsByResource)) {
            const separator = key.indexOf("/");
            paths.set(path, { type: key.slice(0, separator), name: key.slice(separator + 1) });
          }
        resourcesByPath = paths;
        publish({
          status: "ready",
          generation: (state.generation ?? 0) + 1,
          ...previewResultDiagnostics(result.diagnostics, resourcesByPath),
          resources: result.resources,
          payloads: result.payloads.map(({ bytes: _bytes, ...descriptor }) => descriptor),
        });
        for (const resource of updates)
          dispatch("update", `${resource.type}/${resource.name}`, resource);
      } catch (error) {
        if (closed || watchFailed) return;
        if (revision !== requested) continue;
        publish({ status: "error", ...previewErrorDiagnostics(error, resourcesByPath) });
        // State-only consumers are supported: no error listener is not a crash.
        reportError(error, "Compilation failed");
      }
      if (revision === requested) return;
    } while (!closed && !watchFailed);
  }
  function startCompile(): Promise<void> {
    if (closed || watchFailed) return Promise.resolve();
    running ??= drain().finally(() => {
      running = undefined;
    });
    return running;
  }
  function scheduleRecompile() {
    if (closed || watchFailed) return;
    requested++;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (running) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void startCompile();
    }, debounceMs);
  }
  const fsWatcher = chokidarWatch(dir, {
    ignoreInitial: true,
    // Match only below the watched directory: an ancestor named like an ignored
    // directory (for example a project inside `.topik/`) must not hide the project.
    ignored: [(path) => IGNORED_SEGMENT.test(relative(dir, path))],
  });
  fsWatcher.on("add", scheduleRecompile);
  fsWatcher.on("addDir", scheduleRecompile);
  fsWatcher.on("change", scheduleRecompile);
  fsWatcher.on("unlink", scheduleRecompile);
  fsWatcher.on("unlinkDir", scheduleRecompile);
  let fsClosing: Promise<void> | undefined;
  const closeFsWatcher = () => (fsClosing ??= fsWatcher.close());
  const close = async () => {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    options.signal?.removeEventListener("abort", onAbort);
    const closing = closeFsWatcher();
    // Chokidar removes listeners synchronously, but in-flight I/O can still emit errors.
    // Keep a sink even after close resolves, without accumulating it on repeated closes.
    if (fsWatcher.listenerCount("error") === 0) fsWatcher.on("error", () => {});
    await Promise.all([closing, running]);
  };
  const onAbort = () => {
    void close();
  };
  // Lost watch coverage cannot be repaired by a successful compilation. Keep the
  // last good inventory, but require a new watcher before publishing ready again.
  const onWatchError = (error: unknown) => {
    if (closed) return;
    if (!watchFailed) {
      watchFailed = true;
      // No further notifications can be trusted, so release the OS watches now.
      // Closing removes listeners synchronously; keep this handler as the sink for
      // in-flight errors. close() awaits (and reports) the same close promise.
      closeFsWatcher().catch(() => {});
      fsWatcher.on("error", onWatchError);
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    publish({
      status: "error",
      diagnostics: [
        {
          id: "watch-failed",
          message: "Source watching failed. Restart the preview to resume updates.",
          severity: "error",
        },
      ],
    });
    reportError(error, "Source watching failed");
  };
  fsWatcher.on("error", onWatchError);
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const cleanup = () => {
        fsWatcher.off("ready", ready);
        fsWatcher.off("error", failed);
        options.signal?.removeEventListener("abort", ready);
      };
      const ready = () => {
        cleanup();
        resolveReady();
      };
      const failed = (error: unknown) => {
        cleanup();
        rejectReady(error);
      };
      fsWatcher.once("ready", ready);
      fsWatcher.once("error", failed);
      options.signal?.addEventListener("abort", ready, { once: true });
      if (options.signal?.aborted) ready();
    });
  } catch (error) {
    await close();
    throw error;
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) await close();
  else await startCompile();

  const watcher = {
    resources,
    payloads,
    get state() {
      return state;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener);
      return watcher;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      emitter.off(event, listener);
      return watcher;
    },
    close,
  };
  return watcher as Watcher;
}

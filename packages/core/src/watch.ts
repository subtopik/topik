import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { relative, resolve } from "node:path";
import { watch as chokidarWatch } from "chokidar";
import { compile, PublicCompileError, publicCompileErrorMessage } from "./compile";
import type { AssetPayload } from "./compile/assets";
import { digestTopikMaterializationRecord } from "./assets/identity";
import type { Resource } from "./resource";
import { TOPIK_PREVIEW_PROTOCOL, type PreviewState } from "./preview";

export interface WatchOptions {
  dir: string;
  signal?: AbortSignal;
}
export type UpdateListener = (key: string, resource: Resource) => void;
export type ErrorListener = (error: Error) => void;
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

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function watch(options: WatchOptions): Promise<Watcher> {
  const dir = resolve(options.dir);
  const emitter = new EventEmitter();
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
    courseNavigation: {},
  });
  let materializationDigest: string | undefined;
  let requested = 0;
  let closed = false;
  let watchFailed = false;
  let running: Promise<void> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function publish(patch: Partial<PreviewState>) {
    state = freeze({ ...state, ...patch, sequence: state.sequence + 1 });
    emitter.emit("preview-state", state);
  }

  async function drain() {
    do {
      const revision = requested;
      publish({ status: "compiling", diagnostics: [] });
      try {
        const result = await compile({ dir });
        // An edit arrived while reading: discard this candidate, including its payloads.
        if (closed || watchFailed) return;
        if (revision !== requested) continue;
        const nextDigest = digestTopikMaterializationRecord(result.materialization);
        const updates = result.resources.filter((resource) => {
          const existing = resources.get(`${resource.type}/${resource.name}`);
          return (
            JSON.stringify(existing) !== JSON.stringify(resource) ||
            (resource.type === "Asset" && materializationDigest !== nextDigest)
          );
        });
        materializationDigest = nextDigest;
        resources.clear();
        payloads.clear();
        for (const resource of result.resources)
          resources.set(`${resource.type}/${resource.name}`, resource);
        for (const payload of result.payloads) payloads.set(payload.path, payload);
        publish({
          status: "ready",
          generation: (state.generation ?? 0) + 1,
          diagnostics: [],
          resources: result.resources,
          courseNavigation: result.courseNavigation,
          payloads: result.payloads.map(({ bytes: _bytes, ...descriptor }) => descriptor),
        });
        for (const resource of updates)
          emitter.emit("update", `${resource.type}/${resource.name}`, resource);
      } catch (error) {
        if (closed || watchFailed) return;
        if (revision !== requested) continue;
        const id = error instanceof PublicCompileError ? error.id : "compilation-failed";
        publish({
          status: "error",
          diagnostics: [
            {
              id,
              message:
                publicCompileErrorMessage(id) ??
                "Compilation failed. Check the source and try again.",
            },
          ],
        });
        // EventEmitter's unhandled error event throws; state-only consumers are supported.
        if (emitter.listenerCount("error") > 0)
          emitter.emit("error", error instanceof Error ? error : new Error("Compilation failed"));
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
    }, 100);
  }
  const fsWatcher = chokidarWatch(dir, {
    ignoreInitial: true,
    ignored: [
      /(^|[/\\])(?:\.git|\.topik(?:-compilation-(?:generation|prior)-[^/\\]+)?)(?:[/\\]|$)/,
      (path) => /(^|[/\\])node_modules(?:[/\\]|$)/.test(relative(dir, path)),
    ],
  });
  fsWatcher.on("add", scheduleRecompile);
  fsWatcher.on("addDir", scheduleRecompile);
  fsWatcher.on("change", scheduleRecompile);
  fsWatcher.on("unlink", scheduleRecompile);
  fsWatcher.on("unlinkDir", scheduleRecompile);
  const close = async () => {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    options.signal?.removeEventListener("abort", onAbort);
    const closing = fsWatcher.close();
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
  fsWatcher.on("error", (error) => {
    if (closed) return;
    watchFailed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    publish({
      status: "error",
      diagnostics: [
        {
          id: "watch-failed",
          message: "Source watching failed. Restart the preview to resume updates.",
        },
      ],
    });
    if (emitter.listenerCount("error") > 0)
      emitter.emit("error", error instanceof Error ? error : new Error("Source watching failed"));
  });
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

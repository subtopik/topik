import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FSWatcher } from "chokidar";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { compileManifest } from "./compile/manifest";
import type { CompileResult } from "./compile/shared";
import { watch, type Watcher } from "./watch";

const control = vi.hoisted(() => ({
  compile: vi.fn(),
  close: vi.fn(async () => {}),
  fs: undefined as unknown,
  startupError: undefined as Error | undefined,
  pendingStartup: false,
}));
vi.mock("./compile", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  compile: control.compile,
}));
vi.mock("chokidar", async (importOriginal) => {
  const { FSWatcher } = await importOriginal<typeof import("chokidar")>();
  return {
    watch() {
      const events = new FSWatcher();
      const close = events.close.bind(events);
      vi.spyOn(events, "close").mockImplementation(() => {
        const closing = close();
        return Promise.all([closing, control.close()]).then(() => {});
      });
      control.fs = events;
      queueMicrotask(() => {
        if (control.startupError) events.emit("error", control.startupError);
        else if (!control.pendingStartup) events.emit("ready");
      });
      return events;
    },
  };
});
let dir: string | undefined;
let watcher: Watcher | undefined;
afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  control.compile.mockReset();
  control.close.mockClear();
  control.startupError = undefined;
  control.pendingStartup = false;
});
async function fixture() {
  dir = await mkdtemp(join(tmpdir(), "preview-watch-error-"));
  await writeFile(join(dir, ".topik.yaml"), "version: 1\nnamespace: errors\nsources: []\n");
  const result = await compileManifest({ dir });
  control.compile.mockResolvedValue(result);
  return { dir, result };
}
function fs() {
  return control.fs as FSWatcher;
}

test("startup watcher errors close the underlying watcher before rejecting", async () => {
  const error = new Error("ENOSPC: private source path");
  control.startupError = error;
  await expect(watch({ dir: tmpdir() })).rejects.toBe(error);
  expect(control.close).toHaveBeenCalledTimes(1);
  expect(control.compile).not.toHaveBeenCalled();
  expect(fs().listenerCount("ready")).toBe(0);
  expect(() => fs().emit("error", error)).not.toThrow();
});

test.each([false, true])(
  "repeated runtime watcher errors remain safe with public error listener=%s",
  async (listen) => {
    const fixtureData = await fixture();
    watcher = await watch({ dir: fixtureData.dir });
    const previous = watcher.state;
    const errors: Error[] = [];
    if (listen) watcher.on("error", (error) => errors.push(error));
    const error = new Error("EACCES: /private/source");
    for (let index = 0; index < 2; index++) {
      expect(() => fs().emit("error", error)).not.toThrow();
      expect(watcher.state).toMatchObject({
        status: "error",
        generation: previous.generation,
        resources: previous.resources,
        payloads: previous.payloads,
        courseNavigation: previous.courseNavigation,
        diagnostics: [{ id: "watch-failed" }],
      });
      expect(JSON.stringify(watcher.state.diagnostics)).not.toContain("/private/source");
    }
    expect(errors).toHaveLength(listen ? 2 : 0);
    fs().emit("change", "page.md");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(control.compile).toHaveBeenCalledTimes(1);
    expect(watcher.state.status).toBe("error");
  },
);

test.each(["resolve", "reject"] as const)(
  "a compilation that later %ss cannot hide lost watch coverage",
  async (completion) => {
    const fixtureData = await fixture();
    watcher = await watch({ dir: fixtureData.dir });
    const previous = watcher.state;
    let resolve!: (result: CompileResult) => void;
    let reject!: (error: Error) => void;
    control.compile.mockReturnValueOnce(
      new Promise<CompileResult>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    );
    fs().emit("change", "page.md");
    await vi.waitFor(() => expect(control.compile).toHaveBeenCalledTimes(2));
    fs().emit("error", new Error("ENOSPC"));
    const failed = watcher.state;
    if (completion === "resolve") resolve(fixtureData.result);
    else reject(new Error("Compilation also failed"));
    await new Promise((done) => setTimeout(done, 0));
    expect(watcher.state).toBe(failed);
    expect(watcher.state.status).toBe("error");
    expect(watcher.state.generation).toBe(previous.generation);
  },
);

test.each([false, true])(
  "startup abort settles without ready (already aborted=%s)",
  async (alreadyAborted) => {
    control.pendingStartup = true;
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const starting = watch({ dir: tmpdir(), signal: controller.signal });
    if (!alreadyAborted) controller.abort();
    watcher = await starting;
    expect(control.close).toHaveBeenCalledTimes(1);
    expect(control.compile).not.toHaveBeenCalled();
    expect(fs().listenerCount("ready")).toBe(0);
    expect(() => fs().emit("error", new Error("late error"))).not.toThrow();
  },
);

test.each(["failure", "abort", "close"] as const)(
  "late errors stay safe during and after %s cleanup",
  async (reason) => {
    const fixtureData = await fixture();
    const controller = new AbortController();
    const originalError = new Error("startup failure");
    let finishClose!: () => void;
    control.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    if (reason === "failure") control.startupError = originalError;
    if (reason === "abort") control.pendingStartup = true;
    const starting = watch({ dir: fixtureData.dir, signal: controller.signal });
    const outcome = starting.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let closing: Promise<void> | undefined;
    if (reason === "abort") controller.abort();
    if (reason === "close") {
      watcher = await starting;
      closing = watcher.close();
    }
    await vi.waitFor(() => expect(control.close).toHaveBeenCalledTimes(1));
    const state = watcher?.state;
    // Real Chokidar close removes listeners synchronously, before its promise settles.
    expect(fs().listenerCount("change")).toBe(0);
    expect(() => fs()._handleError(new Error("in-flight filesystem failure"))).not.toThrow();
    finishClose();
    await closing;
    const result = await outcome;
    if (reason === "failure") expect(result).toEqual({ error: originalError });
    else if ("value" in result) watcher = result.value;
    expect(() => fs()._handleError(new Error("error after close resolved"))).not.toThrow();
    if (state) expect(watcher?.state).toBe(state);
    else expect(control.compile).not.toHaveBeenCalled();
    if (watcher) {
      await watcher.close();
      await watcher.close();
      expect(fs().listenerCount("error")).toBe(1);
    }
  },
);

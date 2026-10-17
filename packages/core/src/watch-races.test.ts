import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { compileManifest } from "./compile/manifest";
import type { CompileResult } from "./compile/shared";
import { watch, type Watcher } from "./watch";
const control = vi.hoisted(() => ({ compile: vi.fn(), fs: undefined as unknown }));
vi.mock("./compile", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  compile: control.compile,
}));
vi.mock("chokidar", () => ({
  watch() {
    const events = Object.assign(new EventEmitter(), { close: async () => {} });
    control.fs = events;
    queueMicrotask(() => events.emit("ready"));
    return events;
  },
}));
let dir: string;
let watcher: Watcher | undefined;
afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  await rm(dir, { recursive: true, force: true });
  control.compile.mockReset();
});
function deferred() {
  let resolve!: (result: CompileResult) => void;
  const promise = new Promise<CompileResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("serializes work and discards candidates invalidated during compilation", async () => {
  dir = await mkdtemp(join(tmpdir(), "preview-race-"));
  await writeFile(
    join(dir, ".topik.yaml"),
    JSON.stringify({ version: 1, namespace: "race", sources: [] }),
  );
  const result = await compileManifest({ dir });
  const first = deferred();
  const second = deferred();
  control.compile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const starting = watch({ dir });
  await vi.waitFor(() => expect(control.compile).toHaveBeenCalledTimes(1));
  (control.fs as EventEmitter).emit("addDir", "files");
  (control.fs as EventEmitter).emit("change", "intro.md");
  (control.fs as EventEmitter).emit("unlinkDir", "files");
  expect(control.compile).toHaveBeenCalledTimes(1);
  first.resolve({ ...result, courseNavigation: { stale: { modules: [] } } });
  await vi.waitFor(() => expect(control.compile).toHaveBeenCalledTimes(2));
  second.resolve(result);
  watcher = await starting;
  expect(watcher.state).toMatchObject({
    sequence: 3,
    generation: 1,
    status: "ready",
    courseNavigation: {},
  });
  const state = watcher.state;
  const pending = deferred();
  control.compile.mockReturnValueOnce(pending.promise);
  (control.fs as EventEmitter).emit("change");
  await vi.waitFor(() => expect(control.compile).toHaveBeenCalledTimes(3));
  const closing = watcher.close();
  pending.resolve({ ...result, courseNavigation: { late: { modules: [] } } });
  await closing;
  expect(watcher.state.generation).toBe(state.generation);
  expect(watcher.state.courseNavigation).toEqual({});
});

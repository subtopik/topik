import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileGuides, createProjectAssetNameGenerator } from "@topik/core";
import type { LoaderContext } from "astro/loaders";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { topikGuidesLoader } from "./guides";
import { topikWikiLoader } from "./wiki";

vi.mock("@topik/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@topik/core")>();
  return { ...actual, compileGuides: vi.fn(actual.compileGuides) };
});
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
let dir: string;
let watcher: EventEmitter & { add: ReturnType<typeof vi.fn> };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "topik-source-watch-"));
  watcher = Object.assign(new EventEmitter(), { add: vi.fn() });
  await mkdir(join(dir, "images"));
  await writeFile(join(dir, "images/hero.png"), PNG);
  await writeFile(join(dir, "intro.md"), page("Before"));
});
afterEach(async () => {
  watcher.removeAllListeners();
  vi.mocked(compileGuides).mockReset();
  await rm(dir, { recursive: true, force: true });
});
function page(title: string) {
  return `---\ntitle: ${title}\n---\n# ${title}\n\n![Hero](images/hero.png)\n`;
}
function options() {
  return {
    dir,
    name: "source-watch",
    assets: {
      generateName: createProjectAssetNameGenerator({
        projectRoot: dir,
        projectNamespace: "source-watch",
      }),
    },
  };
}
function context(collection = "guides") {
  const entries = new Map<string, { id: string; data: Record<string, unknown>; body?: string }>();
  const publishedTitles: unknown[] = [];
  const error = vi.fn();
  const value = {
    collection,
    watcher,
    store: {
      clear: () => entries.clear(),
      set: (entry: { id: string; data: Record<string, unknown>; body?: string }) => {
        entries.set(entry.id, entry);
        publishedTitles.push(entry.data.title);
      },
    },
    logger: { info: vi.fn(), error },
    generateDigest: (body: string) => body,
  } as unknown as LoaderContext;
  return { value, entries, publishedTitles, error };
}
function changed(path: string, event = "change") {
  watcher.emit("all", event, join(dir, path));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function expectTitle(ctx: ReturnType<typeof context>, title: string) {
  await vi.waitFor(() =>
    expect([...ctx.entries.values()].map((entry) => entry.data.title)).toEqual([title]),
  );
}

test.each(["guides", "wiki"] as const)(
  "%s refreshes content, configuration, additions, removals and nested assets",
  async (kind) => {
    const config = kind === "guides" ? "collection.yaml" : "wiki.yaml";
    const configSource = (extra = false) =>
      kind === "guides"
        ? "id: docs\ntitle: Docs\ntags: [updated]\n"
        : `id: updated-docs\ntitle: Docs\nnavigation: [intro${extra ? ", added" : ""}]\n`;
    await writeFile(
      join(dir, config),
      kind === "guides"
        ? "id: docs\ntitle: Docs\n"
        : "id: docs\ntitle: Docs\nnavigation: [intro]\n",
    );
    const loader = kind === "guides" ? topikGuidesLoader(options()) : topikWikiLoader(options());
    const ctx = context();
    await loader.load(ctx.value);
    expect(watcher.add).toHaveBeenCalledWith(dir);
    expect(loader.getAssets()).toHaveLength(1);
    await writeFile(join(dir, "intro.md"), page("After"));
    changed("intro.md");
    await expectTitle(ctx, "After");

    await writeFile(join(dir, config), configSource());
    changed(config);
    await vi.waitFor(() => {
      const data = [...ctx.entries.values()][0]?.data;
      if (kind === "guides") expect(data?.tags).toEqual(["updated"]);
      else expect(data?.wiki).toBe("updated-docs");
    });
    await writeFile(join(dir, "added.md"), "# Added\n");
    await writeFile(join(dir, config), configSource(true));
    changed("added.md", "add");
    changed(config);
    await vi.waitFor(() => expect(ctx.entries.size).toBe(2));
    await rm(join(dir, "added.md"));
    await writeFile(join(dir, config), configSource());
    changed("added.md", "unlink");
    changed(config);
    await expectTitle(ctx, "After");

    const replacement = Buffer.concat([PNG, Buffer.from([1])]);
    await writeFile(join(dir, "images/hero.png"), replacement);
    changed("images/hero.png");
    const expected = `blobs/${createHash("sha256").update(replacement).digest("hex")}`;
    await vi.waitFor(() => expect(loader.getAssets()[0]?.spec.uri).toBe(expected));
    expect(ctx.entries.size).toBe(1);
    await rm(join(dir, "images/hero.png"));
    changed("images/hero.png", "unlink");
    await vi.waitFor(() => expect(ctx.error).toHaveBeenCalled());
    expect(ctx.entries.size).toBe(0);
    expect(loader.getAssets()).toEqual([]);
    await writeFile(join(dir, "images/hero.png"), PNG);
    changed("images/hero.png", "add");
    await expectTitle(ctx, "After");
    expect(loader.getAssets()).toHaveLength(1);
  },
);

test("an in-flight compilation never publishes a superseded source snapshot", async () => {
  await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
  const loader = topikGuidesLoader(options());
  const ctx = context();
  await loader.load(ctx.value);
  const originalAsset = loader.getAssets()[0].spec.uri;
  const captured = deferred();
  const release = deferred();
  const actual = await vi.importActual<typeof import("@topik/core")>("@topik/core");
  vi.mocked(compileGuides).mockImplementationOnce(async (opts) => {
    const result = await actual.compileGuides(opts);
    captured.resolve();
    await release.promise;
    return result;
  });
  await writeFile(join(dir, "intro.md"), page("Stale"));
  changed("intro.md");
  await captured.promise;
  const replacement = Buffer.concat([PNG, Buffer.from([2])]);
  await writeFile(join(dir, "intro.md"), page("Latest"));
  await writeFile(join(dir, "images/hero.png"), replacement);
  changed("intro.md");
  changed("images/hero.png");
  expect([...ctx.entries.values()][0]?.data.title).toBe("Before");
  expect(loader.getAssets()[0].spec.uri).toBe(originalAsset);
  release.resolve();
  await expectTitle(ctx, "Latest");
  expect(ctx.publishedTitles).not.toContain("Stale");
  expect(loader.getAssets()[0].spec.uri).toBe(
    `blobs/${createHash("sha256").update(replacement).digest("hex")}`,
  );
  expect(compileGuides).toHaveBeenCalledTimes(3);
});

test("equivalent reloaded loaders detach old listeners and serialize pending compilation", async () => {
  await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
  const first = topikGuidesLoader(options());
  const firstContext = context();
  await first.load(firstContext.value);
  const captured = deferred();
  const release = deferred();
  const actual = await vi.importActual<typeof import("@topik/core")>("@topik/core");
  vi.mocked(compileGuides).mockImplementationOnce(async (opts) => {
    const result = await actual.compileGuides(opts);
    captured.resolve();
    await release.promise;
    return result;
  });
  await writeFile(join(dir, "intro.md"), page("Stale"));
  changed("intro.md");
  await captured.promise;
  await writeFile(join(dir, "intro.md"), page("Replacement"));
  const second = topikGuidesLoader(options());
  const secondContext = context();
  const loaded = second.load(secondContext.value);
  expect(watcher.listenerCount("all")).toBe(1);
  expect(compileGuides).toHaveBeenCalledTimes(2);
  release.resolve();
  await loaded;
  expect(firstContext.publishedTitles).toEqual(["Before"]);
  expect(secondContext.publishedTitles).toEqual(["Replacement"]);
  expect(first.getAssets()).toEqual(second.getAssets());
  await second.load(secondContext.value);
  expect(watcher.listenerCount("all")).toBe(1);
  const calls = vi.mocked(compileGuides).mock.calls.length;
  watcher.emit("all", "change", join(dir, "..", "unrelated.md"));
  watcher.emit("all", "change", join(dir, "node_modules", "ignored.md"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(compileGuides).toHaveBeenCalledTimes(calls);
  expect(await readFile(join(dir, "intro.md"), "utf8")).toBe(page("Replacement"));
});

test.each([false, true])(
  "detached in-flight work cannot overwrite or clear a replacement collection (failure: %s)",
  async (failure) => {
    await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
    const first = topikGuidesLoader(options());
    const ctx = context();
    await first.load(ctx.value);
    const captured = deferred();
    const release = deferred();
    const actual = await vi.importActual<typeof import("@topik/core")>("@topik/core");
    vi.mocked(compileGuides).mockImplementationOnce(async (opts) => {
      const result = await actual.compileGuides(opts);
      captured.resolve();
      await release.promise;
      if (failure) throw new Error("Old source failed");
      return result;
    });
    await writeFile(join(dir, "intro.md"), page("Stale"));
    changed("intro.md");
    await captured.promise;
    // Astro removes tracked callbacks before evaluating a new content config.
    watcher.removeAllListeners("all");
    await writeFile(join(dir, "intro.md"), page("Replacement"));
    const replacement = topikGuidesLoader({ ...options(), name: "replacement-source" });
    await replacement.load(ctx.value);
    release.resolve();
    // The held compile has already finished all I/O; drain its completion callbacks.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ctx.publishedTitles).toEqual(["Before", "Replacement"]);
    expect([...ctx.entries.values()][0]?.data.title).toBe("Replacement");
    expect(ctx.error).not.toHaveBeenCalled();
    expect(replacement.getAssets()).toHaveLength(1);
  },
);

test("detaching a watcher cancels a pending debounce before compilation", async () => {
  await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
  const loader = topikGuidesLoader(options());
  const ctx = context();
  await loader.load(ctx.value);
  changed("intro.md");
  watcher.removeAllListeners("all");
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(compileGuides).toHaveBeenCalledTimes(1);
  expect(ctx.publishedTitles).toEqual(["Before"]);
});

test("generated Astro files do not refresh sources or hide similarly named directories", async () => {
  await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
  const loader = topikGuidesLoader(options());
  const ctx = context();
  ctx.value.config = {
    root: pathToFileURL(`${dir}/`),
    cacheDir: pathToFileURL(join(dir, "custom cache")),
  } as LoaderContext["config"];
  const otherListener = vi.fn();
  watcher.on("all", otherListener);
  await loader.load(ctx.value);
  for (const event of ["add", "change", "unlink", "addDir", "unlinkDir"]) {
    changed(".astro/content-assets.mjs", event);
    changed("custom cache/nested/output.mjs", event);
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(compileGuides).toHaveBeenCalledTimes(1);
  expect(otherListener).toHaveBeenCalledTimes(10);
  for (const path of [".astro-content/intro.md", "custom cache-content/intro.md"]) {
    const calls = vi.mocked(compileGuides).mock.calls.length;
    changed(path);
    await vi.waitFor(() => expect(compileGuides).toHaveBeenCalledTimes(calls + 1));
  }
});

test.each(
  [false, true].flatMap((watch) => [false, true].map((equivalent) => ({ watch, equivalent }))),
)("collections sharing a logical source load independently: %j", async ({ watch, equivalent }) => {
  await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
  const first = topikGuidesLoader(options());
  const second = equivalent ? topikGuidesLoader(options()) : first;
  const primary = context("guides");
  const mirror = context("guidesMirror");
  if (!watch) {
    delete primary.value.watcher;
    delete mirror.value.watcher;
  }
  await Promise.all([first.load(primary.value), second.load(mirror.value)]);
  expect(primary.entries.size).toBe(1);
  expect(mirror.entries.size).toBe(1);
  expect(watcher.listenerCount("all")).toBe(watch ? 2 : 0);
  if (watch) {
    await writeFile(join(dir, "intro.md"), page("Shared update"));
    changed("intro.md");
    await Promise.all([
      expectTitle(primary, "Shared update"),
      expectTitle(mirror, "Shared update"),
    ]);
    expect(first.getAssets()).toEqual(second.getAssets());
  }
});

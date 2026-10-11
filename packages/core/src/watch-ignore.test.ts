import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watch as chokidarWatch } from "chokidar";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { compile } from "./compile";
import { watch, type Watcher } from "./watch";

vi.mock("./compile", { spy: true });
vi.mock("chokidar", async (importOriginal) => {
  const original = await importOriginal<typeof import("chokidar")>();
  return { ...original, watch: vi.fn(original.watch) };
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("watch exclusions", () => {
  let temporary: string;
  let dir: string;
  let watcher: Watcher | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    temporary = await mkdtemp(join(tmpdir(), "topik-watch-ignore-"));
    dir = temporary;
    await writeProject();
  });

  async function writeProject() {
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "watch-fixture",
        sources: [{ kind: "collection", config: "collection.yaml" }],
      }),
    );
    await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n");
  }

  afterEach(async () => {
    await watcher?.close();
    await Promise.allSettled(vi.mocked(compile).mock.results.map(({ value }) => value));
    watcher = undefined;
    await rm(temporary, { recursive: true, force: true });
  });

  async function startWatching() {
    watcher = await watch({ dir });
    const fsWatcher = vi.mocked(chokidarWatch).mock.results[0].value;
    await new Promise<void>((resolve) => fsWatcher.once("ready", resolve));
    expect(compile).toHaveBeenCalledTimes(1);
    return watcher;
  }

  test.each(["node_modules", join("node_modules", "project")])(
    "watches a project rooted at %s while excluding its descendant dependencies",
    async (placement) => {
      dir = join(temporary, placement);
      await mkdir(dir, { recursive: true });
      await writeProject();
      const dependencyDirs = [
        join(dir, "node_modules", "example"),
        join(dir, "packages", "nested", "node_modules", "example"),
      ];
      for (const dependencyDir of dependencyDirs) {
        await mkdir(dependencyDir, { recursive: true });
        await writeFile(join(dependencyDir, "index.js"), "initial");
      }
      const activeWatcher = await startWatching();
      const updates = vi.fn();
      activeWatcher.on("update", updates);

      await writeFile(join(dir, "intro.md"), "# Updated\n");
      await vi.waitFor(
        () =>
          expect(updates).toHaveBeenCalledWith(
            "Guide/guides-intro",
            expect.objectContaining({
              spec: expect.objectContaining({ title: "Updated" }),
            }),
          ),
        { timeout: 2_000 },
      );
      expect(compile).toHaveBeenCalledTimes(2);

      for (const dependencyDir of dependencyDirs) {
        await writeFile(join(dependencyDir, "index.js"), "changed");
        await writeFile(join(dependencyDir, "added.js"), "added");
        await rm(join(dependencyDir, "index.js"));
      }
      await delay(350);
      expect(compile).toHaveBeenCalledTimes(2);
      expect(updates).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["node_modules", "packages/nested/node_modules"])(
    "does not recompile for changes, additions, or removals inside %s",
    async (dependencyDir) => {
      const targetDir = join(dir, dependencyDir, "example");
      await mkdir(targetDir, { recursive: true });
      const existingFile = join(targetDir, "index.js");
      await writeFile(existingFile, "initial");
      await startWatching();

      await writeFile(existingFile, "changed");
      await delay(350);
      expect(compile).toHaveBeenCalledTimes(1);

      await writeFile(join(targetDir, "added.js"), "added");
      await delay(350);
      expect(compile).toHaveBeenCalledTimes(1);

      await rm(existingFile);
      await delay(350);
      expect(compile).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["src", ".images", "node_modules-example", "my_node_modules"])(
    "still recompiles for changes inside %s",
    async (sourceDir) => {
      const targetDir = join(dir, sourceDir);
      await mkdir(targetDir);
      const file = join(targetDir, "source.txt");
      await writeFile(file, "initial");
      await startWatching();

      await writeFile(file, "changed");
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    },
  );

  test("matches ignored descendant path segments with either separator", async () => {
    await startWatching();
    const ignored = vi.mocked(chokidarWatch).mock.calls[0][1]?.ignored;
    if (!Array.isArray(ignored)) throw new Error("Expected watcher ignore rules");
    const isIgnored = (path: string) =>
      ignored.some((rule) =>
        typeof rule === "function"
          ? rule(path)
          : rule instanceof RegExp
            ? rule.test(path)
            : rule === path,
      );
    // Chokidar normalizes absolute paths to forward slashes before matching.
    const root = dir.replaceAll("\\", "/");
    expect(isIgnored(root)).toBe(false);

    // Exercise separator matching directly; the filesystem tests use native paths.
    for (const separator of ["/", "\\"]) {
      for (const directory of [
        "node_modules",
        ".git",
        ".topik",
        ".topik-compilation-generation-123",
        ".topik-compilation-prior-123",
      ]) {
        for (const prefix of ["", `nested${separator}`, `nested${separator}child${separator}`]) {
          expect(isIgnored(`${root}/${prefix}${directory}`)).toBe(true);
          expect(isIgnored(`${root}/${prefix}${directory}${separator}file.js`)).toBe(true);
        }
      }
      for (const directory of [
        "src",
        ".images",
        "node_modules-example",
        "my_node_modules",
        ".github",
        ".topik-content",
      ]) {
        expect(isIgnored(`${root}/${directory}${separator}file.js`)).toBe(false);
      }
    }
  });
});

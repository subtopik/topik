import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { watch } from "./watch";
import type { Watcher } from "./watch";

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("watch", () => {
  let dir: string;
  let watcher: Watcher;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-watch-"));
    await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\nWelcome.\n");
  });

  afterEach(async () => {
    await watcher?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("compiles initial resources", async () => {
    watcher = await watch({ dir });

    expect(watcher.resources.size).toBe(1);
    const resource = watcher.resources.get("Guide/guides-intro");
    expect(resource).toBeDefined();
    expect(resource?.type).toBe("Guide");
    expect(resource?.name).toBe("guides-intro");
    expect(resource?.spec.title).toBe("Intro");
  });

  test("emits update when a file changes", async () => {
    watcher = await watch({ dir });

    const updated = new Promise<{ key: string; resource: unknown }>((resolve) => {
      watcher.on("update", (key, resource) => {
        resolve({ key, resource });
      });
    });

    // Wait for chokidar to fully initialize watchers
    await delay(500);
    await writeFile(join(dir, "intro.md"), "# Intro\n\nUpdated content.\n");

    const { key, resource } = await updated;
    expect(key).toBe("Guide/guides-intro");
    expect(resource).toHaveProperty("spec.content.value", "# Intro\n\nUpdated content.\n");
  }, 10_000);

  test("detects new files", async () => {
    watcher = await watch({ dir });
    expect(watcher.resources.size).toBe(1);

    const updated = new Promise<string>((resolve) => {
      watcher.on("update", (key) => {
        if (key === "Guide/guides-advanced") resolve(key);
      });
    });

    await delay(500);
    await writeFile(join(dir, "advanced.md"), "# Advanced\n\nAdvanced guide.\n");

    const key = await updated;
    expect(key).toBe("Guide/guides-advanced");
    expect(watcher.resources.size).toBe(2);
  }, 10_000);

  describe("wiki resources", () => {
    beforeEach(async () => {
      // Replace guide content with wiki content
      await rm(join(dir, "collection.yaml"));
      await rm(join(dir, "intro.md"));
      await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
      await writeFile(join(dir, "intro.md"), "# Intro\n\nWiki intro page.\n");
    });

    test("compiles initial wiki resources", async () => {
      watcher = await watch({ dir });

      expect(watcher.resources.size).toBe(2);
      expect(watcher.resources.get("Wiki/docs")).toBeDefined();
      expect(watcher.resources.get("Wiki/docs")?.type).toBe("Wiki");
      expect(watcher.resources.get("WikiPage/docs-intro")).toBeDefined();
      expect(watcher.resources.get("WikiPage/docs-intro")?.type).toBe("WikiPage");
    });

    test("emits update when a wiki page changes", async () => {
      watcher = await watch({ dir });

      const updates: string[] = [];
      const done = new Promise<void>((resolve) => {
        watcher.on("update", (key) => {
          updates.push(key);
          if (updates.includes("WikiPage/docs-intro")) resolve();
        });
      });

      await delay(500);
      await writeFile(join(dir, "intro.md"), "# Intro\n\nUpdated wiki content.\n");

      await done;
      expect(updates).toContain("WikiPage/docs-intro");
    }, 10_000);
  });

  test("emits error on invalid config", async () => {
    watcher = await watch({ dir });

    const error = new Promise<Error>((resolve) => {
      watcher.on("error", resolve);
    });

    await delay(500);
    await writeFile(join(dir, "collection.yaml"), ":\n  invalid: [yaml");

    const err = await error;
    expect(err).toBeInstanceOf(Error);
  }, 10_000);
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { CompileError } from "./compile";
import { pagePathToName } from "./compile/wiki";
import { DEFAULT_WATCH_DEBOUNCE_MS, watch } from "./watch";
import type { Watcher } from "./watch";
import type { PreviewState } from "./preview";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const find = (state: PreviewState, key: string) =>
  state.resources.find((resource) => `${resource.type}/${resource.name}` === key);
const contentOf = (state: PreviewState, key: string) => {
  const resource = find(state, key);
  return resource && "content" in resource.spec ? resource.spec.content.value : undefined;
};
/** The next successful state that `accept` takes. */
function nextReady(watcher: Watcher, accept: (state: PreviewState) => boolean | undefined) {
  return new Promise<PreviewState>((resolve) => {
    const listener = (state: PreviewState) => {
      if (state.status !== "ready" || !accept(state)) return;
      watcher.off("preview-state", listener);
      resolve(state);
    };
    watcher.on("preview-state", listener);
  });
}

describe("watch", () => {
  let dir: string;
  let watcher: Watcher;
  const introPageKey = `WikiPage/${pagePathToName("docs", "intro")}`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-watch-"));
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "watch-fixture",
        sources: [{ kind: "collection", config: "collection.yaml" }],
      }),
    );
    await writeFile(join(dir, "collection.yaml"), "id: guides\ntitle: Guides\n");
    await writeFile(join(dir, "intro.md"), "# Intro\n\nWelcome.\n");
  });

  afterEach(async () => {
    await watcher?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("compiles initial resources", async () => {
    watcher = await watch({ dir });

    expect(watcher.state.resources).toHaveLength(1);
    const resource = find(watcher.state, "Guide/guides-intro");
    if (resource?.type !== "Guide") throw new Error("expected Guide");
    expect(resource.spec.title).toBe("Intro");
  });

  test("publishes a new generation when a file changes", async () => {
    watcher = await watch({ dir });
    const updated = nextReady(watcher, (state) =>
      contentOf(state, "Guide/guides-intro")?.includes("Updated content."),
    );

    // Wait for chokidar to fully initialize watchers
    await delay(500);
    await writeFile(join(dir, "intro.md"), "# Intro\n\nUpdated content.\n");

    expect(contentOf(await updated, "Guide/guides-intro")).toBe("# Intro\n\nUpdated content.\n");
  }, 10_000);

  test("refreshes an automatic Asset and its payload bytes when the bytes change", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](hero.png)\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    watcher = await watch({ dir });
    const before = watcher.state.payloads[0];
    expect(before).toBeDefined();

    const changedBytes = Uint8Array.from(PNG_BYTES);
    changedBytes[changedBytes.length - 1] ^= 1;
    const updated = nextReady(
      watcher,
      (state) => state.payloads[0]?.integrity !== before.integrity,
    );
    await delay(500);
    await writeFile(join(dir, "hero.png"), changedBytes);

    const state = await updated;
    const asset = state.resources.find((resource) => resource.type === "Asset");
    if (asset?.type !== "Asset") throw new Error("expected Asset");
    expect(asset.spec.integrity).toBe(state.payloads[0].integrity);
    expect([...watcher.payloads.get(state.payloads[0].path)!.bytes]).toEqual([...changedBytes]);
  }, 10_000);

  test("allows more preview clients than the default listener limit", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n");
    watcher = await watch({ dir });
    const warning = vi.spyOn(process, "emitWarning");
    const listeners = Array.from({ length: 20 }, () => () => undefined);
    for (const listener of listeners) watcher.on("preview-state", listener);
    expect(warning).not.toHaveBeenCalled();
    for (const listener of listeners) watcher.off("preview-state", listener);
  });

  test("watches valid assets inside dot-prefixed directories", async () => {
    await mkdir(join(dir, ".images"));
    await writeFile(join(dir, "intro.md"), "# Intro\n\n![Hero](.images/hero.png)\n");
    await writeFile(join(dir, ".images", "hero.png"), PNG_BYTES);
    watcher = await watch({ dir });
    const before = watcher.state.payloads[0];
    const changedBytes = Uint8Array.from(PNG_BYTES);
    changedBytes[changedBytes.length - 1] ^= 1;
    const updated = nextReady(
      watcher,
      (state) => state.payloads[0]?.integrity !== before.integrity,
    );

    await delay(500);
    await writeFile(join(dir, ".images", "hero.png"), changedBytes);

    const state = await updated;
    expect([...watcher.payloads.get(state.payloads[0].path)!.bytes]).toEqual([...changedBytes]);
  }, 10_000);

  test("detects new files", async () => {
    watcher = await watch({ dir });
    expect(watcher.state.resources).toHaveLength(1);
    const updated = nextReady(watcher, (state) => !!find(state, "Guide/guides-advanced"));

    await delay(500);
    await writeFile(join(dir, "advanced.md"), "# Advanced\n\nAdvanced guide.\n");

    expect((await updated).resources).toHaveLength(2);
  }, 10_000);

  describe("wiki resources", () => {
    beforeEach(async () => {
      // Replace guide content with wiki content
      await rm(join(dir, "collection.yaml"));
      await rm(join(dir, "intro.md"));
      await writeFile(
        join(dir, ".topik.yaml"),
        JSON.stringify({
          version: 1,
          namespace: "watch-fixture",
          sources: [{ kind: "wiki", config: "wiki.yaml" }],
        }),
      );
      await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation:\n  - intro\n");
      await writeFile(join(dir, "intro.md"), "# Intro\n\nWiki intro page.\n");
    });

    test("compiles initial wiki resources", async () => {
      watcher = await watch({ dir });

      expect(watcher.state.resources).toHaveLength(2);
      expect(find(watcher.state, "Wiki/docs")?.type).toBe("Wiki");
      expect(find(watcher.state, introPageKey)?.type).toBe("WikiPage");
    });

    test("publishes a new generation when a wiki page changes", async () => {
      watcher = await watch({ dir });
      const updated = nextReady(watcher, (state) =>
        contentOf(state, introPageKey)?.includes("Updated wiki content."),
      );

      await delay(500);
      await writeFile(join(dir, "intro.md"), "# Intro\n\nUpdated wiki content.\n");

      expect(contentOf(await updated, introPageKey)).toContain("Updated wiki content.");
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

  test("reports an initial compile failure to onError with its located diagnostics", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Missing](#missing)\n");
    const errors: Error[] = [];

    watcher = await watch({ dir, onError: (error) => errors.push(error) });

    expect(watcher.state.status).toBe("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(CompileError);
    expect((errors[0] as CompileError).diagnostics).toEqual([
      expect.objectContaining({ file: "intro.md", level: "error" }),
    ]);
  });

  test("passes the link validation policy to every compilation", async () => {
    await writeFile(join(dir, "intro.md"), "# Intro\n\n[Missing](#missing)\n");

    watcher = await watch({ dir, validation: { links: "warning" } });

    expect(watcher.state.status).toBe("ready");
    expect(find(watcher.state, "Guide/guides-intro")).toBeDefined();
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "100"])(
    "rejects the debounce interval %j before watching",
    async (debounceMs) => {
      await expect(watch({ dir, debounceMs: debounceMs as number })).rejects.toThrow(
        new RangeError(`Watch debounceMs must be an integer from 0 to 2147483647 milliseconds`),
      );
    },
  );

  test("rejects a malformed Git executable before watching", async () => {
    await expect(watch({ dir, gitExecutable: "git" })).rejects.toThrow(
      new TypeError("gitExecutable must be an absolute path to a Git executable"),
    );
  });

  test("keeps the default debounce interval", () => {
    expect(DEFAULT_WATCH_DEBOUNCE_MS).toBe(100);
  });

  test("waits for a quiet configured debounce interval and coalesces edits into one compile", async () => {
    const debounceMs = 1_000;
    watcher = await watch({ dir, debounceMs });
    const compiling: number[] = [];
    watcher.on("preview-state", (state) => {
      if (state.status === "compiling") compiling.push(performance.now());
    });
    const updated = nextReady(watcher, (state) =>
      contentOf(state, "Guide/guides-intro")?.includes("Three."),
    );

    await delay(500);
    let lastEdit = 0;
    for (const body of ["One.", "Two.", "Three."]) {
      lastEdit = performance.now();
      await writeFile(join(dir, "intro.md"), `# Intro\n\n${body}\n`);
      await delay(200);
    }

    expect(contentOf(await updated, "Guide/guides-intro")).toBe("# Intro\n\nThree.\n");
    expect(compiling).toHaveLength(1);
    // The timer restarts on each notification, so compilation starts a full interval after
    // the last edit, not after the first. Only a lower bound: a loaded machine may be slower.
    expect(compiling[0] - lastEdit).toBeGreaterThanOrEqual(debounceMs);
  }, 15_000);

  test("accepts a zero debounce interval", async () => {
    watcher = await watch({ dir, debounceMs: 0 });
    const updated = nextReady(watcher, (state) =>
      contentOf(state, "Guide/guides-intro")?.includes("Immediate."),
    );

    await delay(500);
    await writeFile(join(dir, "intro.md"), "# Intro\n\nImmediate.\n");

    expect(contentOf(await updated, "Guide/guides-intro")).toBe("# Intro\n\nImmediate.\n");
  }, 10_000);
});

describe("authoritative preview state", () => {
  let dir: string;
  let watcher: Watcher;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preview-state-"));
    await writeFile(
      join(dir, ".topik.yaml"),
      JSON.stringify({
        version: 1,
        namespace: "preview",
        sources: [{ kind: "course", config: "course.yaml" }],
      }),
    );
  });
  afterEach(async () => {
    await watcher?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const configuration = (pages = ["z", "a"]) =>
    JSON.stringify({
      id: "course",
      title: "Course",
      slug: "course",
      modules: [{ id: "module", title: "Module", slug: "module", pages }],
    });
  async function sources() {
    await writeFile(join(dir, "course.yaml"), configuration());
    for (const name of ["z", "a"])
      await writeFile(
        join(dir, `${name}.md`),
        `---\nid: ${name}\ntitle: ${name}\nslug: ${name}\n---\n# ${name}\n`,
      );
  }
  function next(status: "ready" | "error") {
    return new Promise<import("./preview").PreviewState>((resolve) => {
      const listener = (state: import("./preview").PreviewState) => {
        if (state.status === status) {
          watcher.off("preview-state", listener);
          resolve(state);
        }
      };
      watcher.on("preview-state", listener);
    });
  }
  test("publishes order-only edits, deletion, failure retention and identical recovery", async () => {
    await sources();
    watcher = await watch({ dir });
    const initial = watcher.state;
    const states: import("./preview").PreviewState[] = [];
    watcher.on("preview-state", (state) => states.push(state));
    let done = next("ready");
    await writeFile(join(dir, "course.yaml"), configuration(["a", "z"]));
    const reordered = await done;
    const pages = (state: import("./preview").PreviewState) =>
      state.resources.find((r) => r.type === "CourseModule")?.spec.pages;
    // Order lives in the module's page list, so a reorder changes exactly that list.
    expect(pages(initial)).toEqual(["z", "a"]);
    expect(pages(reordered)).toEqual(["a", "z"]);
    expect(reordered.resources.filter((r) => r.type === "CoursePage")).toEqual(
      initial.resources.filter((r) => r.type === "CoursePage"),
    );
    expect(reordered.generation).toBe(initial.generation! + 1);
    done = next("error");
    await writeFile(join(dir, "course.yaml"), "title: [PRIVATE_VALUE");
    const failed = await done;
    expect(failed.generation).toBe(reordered.generation);
    expect(failed.resources).toBe(reordered.resources);
    expect(JSON.stringify(failed)).not.toMatch(/PRIVATE_VALUE|\/tmp\//u);
    done = next("ready");
    await writeFile(join(dir, "course.yaml"), configuration(["a", "z"]));
    const recovered = await done;
    expect(recovered.resources).toEqual(reordered.resources);
    expect(recovered.diagnostics).toEqual([]);
    done = next("ready");
    await writeFile(join(dir, "course.yaml"), configuration([]));
    const deleted = await done;
    expect(deleted.resources.filter((r) => r.type === "CoursePage")).toEqual([]);
    expect(pages(deleted)).toEqual([]);
    expect(states.map((s) => s.status)).toEqual([
      "compiling",
      "ready",
      "compiling",
      "error",
      "compiling",
      "ready",
      "compiling",
      "ready",
    ]);
    expect(states.every((s, i) => s.sequence === initial.sequence + i + 1)).toBe(true);
  });
  test("recovers from an initial failure and changes session identity on restart", async () => {
    watcher = await watch({ dir });
    expect(watcher.state).toMatchObject({
      status: "error",
      generation: null,
      resources: [],
    });
    const session = watcher.state.sessionId;
    const ready = next("ready");
    await sources();
    await ready;
    expect(watcher.state.generation).toBe(1);
    await watcher.close();
    watcher = await watch({ dir });
    expect(watcher.state.sessionId).not.toBe(session);
    expect(watcher.state.sequence).toBe(2);
  });
});

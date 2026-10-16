import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { compile } from "./compile";
import { watch, type Watcher } from "./watch";

let dir: string;
let watcher: Watcher | undefined;
afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  await rm(dir, { recursive: true, force: true });
});

test("empty directory creation invalidates links and removal recovers the preview", async () => {
  dir = await mkdtemp(join(tmpdir(), "topik-watch-directories-"));
  await writeFile(
    join(dir, ".topik.yaml"),
    JSON.stringify({
      version: 1,
      namespace: "directory-links",
      sources: [{ kind: "wiki", config: "wiki.yaml" }],
    }),
  );
  await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\nnavigation: [intro, files]\n");
  await writeFile(join(dir, "intro.md"), "# Intro\n\n[Files](./files)\n");
  await writeFile(join(dir, "files.md"), "# Files\n");
  watcher = await watch({ dir });
  expect(watcher.state.status).toBe("ready");
  const generation = watcher.state.generation;
  const errors: Error[] = [];
  watcher.on("error", (error) => errors.push(error));

  await mkdir(join(dir, "files"));
  await vi.waitFor(() => expect(watcher?.state.status).toBe("error"), { timeout: 3000 });
  await expect(compile({ dir })).rejects.toMatchObject({
    diagnostics: expect.arrayContaining([expect.objectContaining({ id: "link-page-not-found" })]),
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    diagnostics: expect.arrayContaining([expect.objectContaining({ id: "link-page-not-found" })]),
  });
  expect(watcher.state.generation).toBe(generation);

  await rm(join(dir, "files"), { recursive: true });
  await vi.waitFor(() => expect(watcher?.state.status).toBe("ready"), { timeout: 3000 });
  expect(watcher.state.generation).toBe((generation ?? 0) + 1);
  const fresh = await compile({ dir });
  expect(watcher.state.resources).toEqual(fresh.resources);
});

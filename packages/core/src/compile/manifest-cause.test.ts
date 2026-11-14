import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { compileManifest } from "./manifest";

// Unexpected discovery failures (descriptor exhaustion, permissions, internal faults)
// cannot be produced portably from a fixture, so discovery is replaced here.
const failure = vi.hoisted(() =>
  Object.assign(new Error("EMFILE: too many open files, open '/private/path'"), {
    code: "EMFILE",
  }),
);
vi.mock("./wiki", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./wiki")>()),
  discoverWiki: vi.fn(async () => {
    throw failure;
  }),
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("unexpected source failures keep a private cause behind fixed public wording", async () => {
  const dir = await mkdtemp(join(tmpdir(), "topik-manifest-cause-"));
  roots.push(dir);
  await writeFile(
    join(dir, ".topik.yaml"),
    JSON.stringify({
      version: 1,
      namespace: "example/project",
      sources: [{ kind: "wiki", config: "wiki.yaml" }],
    }),
  );
  await writeFile(join(dir, "wiki.yaml"), "id: docs\ntitle: Docs\n");

  const error = await compileManifest({ dir }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    name: "ManifestSourceError",
    id: "manifest-source-failed",
    message: "Manifest source could not be compiled.",
    location: "wiki.yaml",
    sourceIndex: 0,
  });
  expect((error as Error).cause).toBe(failure);
  expect(`${String(error)}\n${JSON.stringify(error)}`).not.toContain("/private/path");
});

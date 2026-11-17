import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { AssetCompilationError } from "./assets";
import { classifyCompileFailure } from "./failure";
import { compileManifest, ManifestSourceError } from "./manifest";
import { PublicCompileError } from "./public-errors";
import { CompileError } from "./shared";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "topik-failure-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

const project = {
  ".topik.yaml":
    "version: 1\nnamespace: example/failure\nsources:\n  - kind: wiki\n    config: wiki.yaml\n",
  "wiki.yaml": "id: docs\ntitle: Docs\nnavigation: [index]\n",
};
// A one-pixel PNG: a signature, IHDR, IDAT and IEND.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const LFS_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12345\n`;

async function failure(): Promise<unknown> {
  return compileManifest({ dir }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

test("an image that is a Git LFS pointer fails with its own reason", async () => {
  await write({ ...project, "index.md": "# Home\n\n![Pic](./pic.png)\n", "pic.png": LFS_POINTER });

  const error = await failure();

  expect(error).toBeInstanceOf(AssetCompilationError);
  expect(error).toMatchObject({
    reason: "git-lfs-pointer",
    diagnostics: [{ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED", location: { path: "pic.png" } }],
  });
  expect(classifyCompileFailure(error)).toEqual({ kind: "asset", reason: "git-lfs-pointer" });
});

test("a damaged image fails as an Asset without a read-failure reason", async () => {
  await write({
    ...project,
    "index.md": "# Home\n\n![Pic](./pic.png)\n",
    "pic.png": "<script>not an image</script>",
  });

  const error = await failure();

  expect(error).toBeInstanceOf(AssetCompilationError);
  expect((error as AssetCompilationError).reason).toBeUndefined();
  expect(classifyCompileFailure(error)).toEqual({ kind: "asset" });
});

test("invalid page content is a content failure", async () => {
  await write({ ...project, "index.md": "# Home\n\n<b>raw</b>\n" });

  const error = await failure();

  expect(error).toBeInstanceOf(CompileError);
  expect(classifyCompileFailure(error)).toEqual({ kind: "content" });
});

test("manifest and configuration failures are configuration failures with their ID", async () => {
  expect(classifyCompileFailure(await failure())).toEqual({
    kind: "configuration",
    id: "manifest-required",
    location: ".topik.yaml",
  });

  await write({ ...project, "wiki.yaml": "id: Not Valid\n" });
  const error = await failure();
  expect(error).toBeInstanceOf(ManifestSourceError);
  expect(classifyCompileFailure(error)).toMatchObject({
    kind: "configuration",
    id: "config-invalid",
    location: "wiki.yaml",
  });
});

test("a missing page is a content failure; a platform refusal is the environment", async () => {
  await write(project);
  expect(classifyCompileFailure(await failure())).toMatchObject({
    kind: "content",
    id: "wiki-page-not-found",
  });

  expect(
    classifyCompileFailure(
      new PublicCompileError("config-read-failed", ".topik.yaml", {
        reason: "platform-unsupported",
      }),
    ),
  ).toEqual({
    kind: "environment",
    id: "config-read-failed",
    reason: "platform-unsupported",
    location: ".topik.yaml",
  });
  // The author's own file is at fault, so the kind stays with the ID.
  expect(
    classifyCompileFailure(
      new PublicCompileError("config-read-failed", "wiki.yaml", { reason: "symbolic-link" }),
    ),
  ).toMatchObject({ kind: "configuration", reason: "symbolic-link" });
  expect(
    classifyCompileFailure(
      new AssetCompilationError("Local Asset bytes could not be proven", [], {
        reason: "changed-during-read",
      }),
    ),
  ).toEqual({ kind: "environment", reason: "changed-during-read" });
});

test("tool faults and unrelated values are told apart from the author's project", () => {
  expect(classifyCompileFailure(new PublicCompileError("manifest-source-failed"))).toEqual({
    kind: "tool",
    id: "manifest-source-failed",
  });
  expect(classifyCompileFailure(new PublicCompileError("reference-targets-invalid")).kind).toBe(
    "tool",
  );
  for (const value of [new Error("boom"), new TypeError("x"), "text", undefined, null, 1])
    expect(classifyCompileFailure(value)).toEqual({ kind: "unknown" });
});

test("reports the source file of every local Asset, and keeps it out of the records", async () => {
  await write({
    ...project,
    "index.md":
      "# Home\n\n![One](./img/one.png)\n\n![Copy](./img/copy.png)\n\n![Again](./img/one.png)\n\n" +
      "![Remote](https://example.com/remote.png)\n",
    "img/one.png": PNG,
    "img/copy.png": PNG,
  });

  const result = await compileManifest({ dir });

  // Two files with the same bytes: two Asset names, one payload.
  expect(result.payloads).toHaveLength(1);
  const [payload] = result.payloads;
  expect(payload!.assetNames).toHaveLength(2);
  expect(Object.keys(result.assetSourcePaths).sort()).toEqual([...payload!.assetNames].sort());
  expect(payload!.assetNames.map((name) => result.assetSourcePaths[name]).sort()).toEqual([
    "img/copy.png",
    "img/one.png",
  ]);
  expect(Object.keys(payload!).sort()).toEqual([
    "assetNames",
    "bytes",
    "integrity",
    "mediaType",
    "path",
    "size",
  ]);
  const records = JSON.stringify([result.semantic, result.materialization, result.resources]);
  expect(records).not.toContain("img/one.png");
  expect(records).not.toContain("img/copy.png");
});

test("a project without local Assets has an empty source-path map", async () => {
  await write({ ...project, "index.md": "# Home\n" });
  expect((await compileManifest({ dir })).assetSourcePaths).toEqual({});
});

test("Asset source paths are relative to the project directory, not to the source", async () => {
  await write({
    ".topik.yaml":
      "version: 1\nnamespace: example/failure\nsources:\n  - kind: wiki\n    config: docs/wiki.yaml\n",
    "docs/wiki.yaml": "id: docs\ntitle: Docs\nnavigation: [guides/setup]\n",
    "docs/guides/setup.md": "# Setup\n\n![Pic](../img/pic.png)\n",
    "docs/img/pic.png": PNG,
  });

  expect(Object.values((await compileManifest({ dir })).assetSourcePaths)).toEqual([
    "docs/img/pic.png",
  ]);
});

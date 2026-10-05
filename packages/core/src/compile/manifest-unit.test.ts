import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { compile } from "./index";
import { generateAutomaticAssetName } from "../assets/asset";
import { validateTopikMaterializationRecord } from "../assets/identity";

// These tests exercise compilation with a deterministic byte reader. Filesystem
// admission, descriptor anchoring, and output replacement have separate integration tests.
const bytesByPath = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("../assets/files", async (importOriginal) => {
  const original = await importOriginal<typeof import("../assets/files")>();
  return {
    ...original,
    readPortableAssetFile: vi.fn(async ({ root, path }: { root: string; path: string }) => {
      const bytes = bytesByPath.get(join(root, path));
      return original.validatePortableAssetFile({
        path,
        bytes,
        type: "regular",
        mode: "100644",
        source: "git",
      });
    }),
  };
});

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const roots: string[] = [];
async function fixture(files: Record<string, string | Uint8Array>) {
  const root = await mkdtemp(join(tmpdir(), "topik-project-unit-"));
  roots.push(root);
  for (const [path, value] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, value);
    bytesByPath.set(absolute, typeof value === "string" ? Buffer.from(value) : value);
  }
  return root;
}
afterEach(async () => {
  bytesByPath.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const manifest = (namespace: string, configs: string[]) =>
  JSON.stringify({
    version: 1,
    namespace,
    sources: configs.map((config) => ({ kind: "wiki", config })),
  });
const wiki = (id: string) => `id: ${id}\ntitle: ${id}\nnavigation: [index]`;

test("one project asset identity spans overlapping sources, with closed inventories and stable ordering", async () => {
  const files = {
    ".topik.yaml": manifest("example/docs", ["wiki.yaml", "nested/wiki.yaml"]),
    "wiki.yaml": wiki("parent"),
    "index.md": "![Logo](nested/logo.png)",
    "nested/wiki.yaml": wiki("child"),
    "nested/index.md": "![Logo](logo.png)",
    "nested/logo.png": PNG,
  };
  const first = await compile({ dir: await fixture(files) });
  const second = await compile({
    dir: await fixture({
      ...files,
      ".topik.yaml": manifest("example/docs", ["nested/wiki.yaml", "wiki.yaml"]),
    }),
  });
  const expected = generateAutomaticAssetName({
    stableSourceNamespace: "example/docs",
    normalizedPath: "nested/logo.png",
  });
  expect(first.semantic.assetNames).toEqual(expected.ok ? [expected.value] : []);
  expect(first.semantic.references).toHaveLength(2);
  expect(first.payloads).toHaveLength(1);
  expect(second.resources).toEqual(first.resources);
  expect(second.materialization).toEqual(first.materialization);
  expect(
    validateTopikMaterializationRecord(first.materialization, first.resources, first.semantic).ok,
  ).toBe(true);
});

test("different manifest-relative paths have distinct identities but share equal bytes", async () => {
  const dir = await fixture({
    ".topik.yaml": manifest("example/docs", ["a/wiki.yaml", "b/wiki.yaml"]),
    "a/wiki.yaml": wiki("a"),
    "a/index.md": "![Logo](logo.png)",
    "a/logo.png": PNG,
    "b/wiki.yaml": wiki("b"),
    "b/index.md": "![Logo](logo.png)",
    "b/logo.png": PNG,
  });
  const result = await compile({ dir });
  expect(result.semantic.assetNames).toHaveLength(2);
  expect(result.payloads).toHaveLength(1);
  expect(result.payloads[0].assetNames).toHaveLength(2);
});

test("namespace changes regenerate IDs without changing bytes", async () => {
  const files = { "wiki.yaml": wiki("docs"), "index.md": "![Logo](logo.png)", "logo.png": PNG };
  const first = await compile({
    dir: await fixture({ ...files, ".topik.yaml": manifest("example/first", ["wiki.yaml"]) }),
  });
  const second = await compile({
    dir: await fixture({ ...files, ".topik.yaml": manifest("example/second", ["wiki.yaml"]) }),
  });
  expect(first.semantic.assetNames).not.toEqual(second.semantic.assetNames);
  expect(first.payloads[0].bytes).toEqual(second.payloads[0].bytes);
  expect(first.payloads[0].path).toBe(second.payloads[0].path);
});

test("requires valid manifests and namespaces even without local assets", async () => {
  const dir = await fixture({ "wiki.yaml": wiki("docs") });
  await expect(compile({ dir })).rejects.toMatchObject({ id: "manifest-required" });
  for (const raw of [
    '{"version":1,"sources":[]}',
    manifest("", []),
    "version: 2\nnamespace: example/docs\nsources: []",
  ]) {
    await expect(compile({ dir: await fixture({ ".topik.yaml": raw }) })).rejects.toMatchObject({
      id: "manifest-invalid",
    });
  }
  const empty = await compile({
    dir: await fixture({ ".topik.yaml": manifest("example/docs", []) }),
  });
  expect(empty.resources).toEqual([]);
});

test("source containment and project-wide path collision checks remain enforced", async () => {
  const outside = await fixture({
    ".topik.yaml": manifest("example/docs", ["nested/wiki.yaml"]),
    "nested/wiki.yaml": wiki("child"),
    "nested/index.md": "![Logo](../logo.png)",
    "logo.png": PNG,
  });
  await expect(compile({ dir: outside })).rejects.toThrow();
  const aliased = await fixture({
    ".topik.yaml": manifest("example/docs", ["wiki.yaml", "nested/wiki.yaml"]),
    "wiki.yaml": wiki("parent"),
    "index.md": "![Logo](nested/Logo.png)",
    "nested/Logo.png": PNG,
    "nested/wiki.yaml": wiki("child"),
    "nested/index.md": "![Logo](logo.png)",
    "nested/logo.png": PNG,
  });
  await expect(compile({ dir: aliased })).rejects.toThrow("Compilation paths collide");
});

test("consumed source files cannot become assets through another source", async () => {
  const dir = await fixture({
    ".topik.yaml": manifest("example/docs", ["wiki.yaml", "nested/wiki.yaml"]),
    "wiki.yaml": wiki("parent"),
    "index.md": "![Config](nested/wiki.yaml)",
    "nested/wiki.yaml": wiki("child"),
    "nested/index.md": "# Child",
  });
  await expect(compile({ dir })).rejects.toThrow(
    "Local reference conflicts with a compiler input path",
  );
});

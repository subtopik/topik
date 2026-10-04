import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { compile, compileWiki, compileGuides } from "./index";
import {
  compileManifest,
  deriveManifestSourceNamespace,
  loadTopikManifest,
  mergeManifestCompilations,
} from "./manifest";
import { validateTopikMaterializationRecord } from "../assets/identity";
import { parseTopikManifest } from "../config/manifest";

const roots: string[] = [];
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
async function fixture(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "topik-manifest-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
const sources = (entries: { kind: string; config: string }[]) =>
  JSON.stringify({ version: 1, sources: entries });
const wiki = (id: string) => `id: ${id}\ntitle: ${id}\nnavigation: [index]\n`;
const assets = { sourceNamespace: "repository:example" };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("root manifest compilation", () => {
  test("compiles two Wikis and a collection from exact configs with local bases", async () => {
    const entries = [
      { kind: "wiki", config: "docs/custom.yml" },
      { kind: "collection", config: "guides/settings.json" },
      { kind: "wiki", config: "handbook/reference/wiki.yaml" },
    ];
    const dir = await fixture({
      ".topik.yaml": sources(entries),
      "docs/custom.yml": wiki("docs") + "assets:\n  directory: media/uploads\n",
      "docs/index.md": "# Docs\n![logo](images/logo.png)",
      "docs/images/logo.png": PNG,
      "docs/wiki.yaml": "invalid",
      "guides/settings.json": '{"id":"guides","title":"Guides"}',
      "guides/first.md": "# Guide",
      "handbook/reference/wiki.yaml": wiki("handbook"),
      "handbook/reference/index.md": "# Handbook",
      "wiki.yaml": "invalid",
      "collection.yaml": "invalid",
      "unlisted.md": "bad <script>",
      "docs/.topik.yaml": "invalid",
    });
    const result = await compileManifest({ dir, assets });
    expect(result.resources.map((resource) => resource.type).sort()).toEqual([
      "Asset",
      "Guide",
      "Wiki",
      "Wiki",
      "WikiPage",
      "WikiPage",
    ]);
    expect(result.provenance.map((source) => source.assetDirectory)).toEqual([
      "docs/media/uploads",
      "guides/_assets",
      "handbook/reference/_assets",
    ]);
    expect(result.provenance.map((source) => source.config)).toEqual(
      entries.map((entry) => entry.config),
    );
    expect(Object.values(result.provenance[0].sourcePathsByResource)).toContain("docs/index.md");
    const namespace = result.provenance[0].sourceNamespace;
    const standalone = await compileWiki({
      dir,
      configFile: "docs/custom.yml",
      assets: { sourceNamespace: namespace },
    });
    expect(
      result.resources.filter(
        (resource) => resource.type === "Asset" || resource.name.startsWith("docs"),
      ),
    ).toEqual(standalone.resources);
    expect(await compile({ dir: relative(process.cwd(), dir), assets })).toEqual(result);
    await writeFile(join(dir, ".topik.yaml"), sources(entries.toReversed()));
    const reversed = await compile({ dir, assets });
    expect(reversed.resources).toEqual(result.resources);
    expect(reversed.payloads).toEqual(result.payloads);
    expect(reversed.semantic).toEqual(result.semantic);
    expect(reversed.materialization).toEqual(result.materialization);
    expect(await readFile(join(dir, "docs/custom.yml"), "utf8")).toBe(
      wiki("docs") + "assets:\n  directory: media/uploads\n",
    );
  });

  test("shares media between a Wiki and collection in the same directory", async () => {
    const dir = await fixture({
      ".topik.yaml": sources([
        { kind: "wiki", config: "docs/wiki.yaml" },
        { kind: "collection", config: "docs/collection.yaml" },
      ]),
      "docs/wiki.yaml": wiki("docs"),
      "docs/collection.yaml": "id: guides\ntitle: Guides",
      "docs/index.md": "# Shared\n![logo](logo.png)",
      "docs/logo.png": PNG,
    });
    const result = await compileManifest({ dir, assets });
    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
    expect(result.semantic.references).toHaveLength(2);
    expect(result.payloads).toHaveLength(1);
    expect(result.provenance[0].sourceNamespace).toBe(result.provenance[1].sourceNamespace);
    expect(
      validateTopikMaterializationRecord(result.materialization, result.resources, result.semantic)
        .ok,
    ).toBe(true);
    const standalone = await compile({
      dir: join(dir, "docs"),
      assets: { sourceNamespace: result.provenance[0].sourceNamespace },
    });
    expect(standalone.resources).toEqual(result.resources);
    expect(standalone.materialization).toEqual(result.materialization);
  });

  test.each([true, false])(
    "distinct directories keep distinct identities; equal bytes deduplicate: %s",
    async (equal) => {
      // A distinct valid PNG pin (ancillary trailing bytes are permitted by the media classifier).
      const other = equal ? PNG : Buffer.concat([PNG, Buffer.from("other")]);
      const dir = await fixture({
        ".topik.yaml": sources([
          { kind: "wiki", config: "a/wiki.yaml" },
          { kind: "wiki", config: "b/wiki.yaml" },
        ]),
        "a/wiki.yaml": wiki("a"),
        "b/wiki.yaml": wiki("b"),
        "a/index.md": "![logo](images/logo.png)",
        "b/index.md": "![logo](images/logo.png)",
        "a/images/logo.png": PNG,
        "b/images/logo.png": other,
      });
      const result = await compileManifest({ dir, assets });
      expect(new Set(result.semantic.assetNames).size).toBe(2);
      expect(result.semantic.references).toHaveLength(2);
      expect(result.payloads).toHaveLength(equal ? 1 : 2);
      expect(result.payloads.flatMap((payload) => payload.assetNames).sort()).toEqual(
        [...result.semantic.assetNames].sort(),
      );
      expect(
        validateTopikMaterializationRecord(
          result.materialization,
          result.resources,
          result.semantic,
        ).ok,
      ).toBe(true);
      expect(result.provenance[0].sourceNamespace).not.toBe(result.provenance[1].sourceNamespace);
    },
  );

  test("namespace derivation has a stable public vector, root spelling, and validation", () => {
    const expected = createHash("sha256").update('["repository:example","docs"]').digest("hex");
    expect(deriveManifestSourceNamespace(assets.sourceNamespace, "docs")).toBe(
      `topik-manifest-source-v1:${expected}`,
    );
    expect(deriveManifestSourceNamespace(assets.sourceNamespace, "")).not.toBe(
      deriveManifestSourceNamespace(assets.sourceNamespace, "docs"),
    );
    expect(() => deriveManifestSourceNamespace("", "docs")).toThrow();
    expect(() => deriveManifestSourceNamespace("repo", "../docs")).toThrow();
  });

  test("missing namespace preserves the existing actionable error", async () => {
    const dir = await fixture({
      ".topik.yaml": sources([{ kind: "wiki", config: "wiki.yaml" }]),
      "wiki.yaml": wiki("docs"),
      "index.md": "![logo](logo.png)",
      "logo.png": PNG,
    });
    await expect(compile({ dir })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_SOURCE_NAMESPACE_REQUIRED" }),
      ]),
    });
  });

  test("empty manifest ignores conventional files, and explicit missing manifest fails", async () => {
    const dir = await fixture({ ".topik.yaml": "version: 1\nsources: []", "wiki.yaml": "invalid" });
    expect((await compile({ dir })).resources).toEqual([]);
    await rm(join(dir, ".topik.yaml"));
    await expect(loadTopikManifest(dir)).rejects.toMatchObject({ id: "config-not-found" });
  });

  test("standalone calls ignore root and ancestor manifests and use declared kind", async () => {
    const dir = await fixture({
      ".topik.yaml": "invalid",
      "nested/wiki.yaml": "id: docs\ntitle: Docs",
      "nested/index.md": "# Guide",
    });
    expect((await compileWiki({ dir: join(dir, "nested") })).resources[0].type).toBe("Wiki");
    expect((await compileGuides({ dir, configFile: "nested/wiki.yaml" })).resources[0].type).toBe(
      "Guide",
    );
    expect((await compile({ dir: join(dir, "nested") })).resources[0].type).toBe("Wiki");
    await expect(compileWiki({ dir, configFile: "nested/missing.yaml" })).rejects.toMatchObject({
      id: "config-not-found",
    });
  });

  test("the manifest kind selects the parser even when the filename suggests another kind", async () => {
    const dir = await fixture({
      ".topik.yaml": sources([{ kind: "collection", config: "wiki.yaml" }]),
      "wiki.yaml": "id: shared\ntitle: Shared",
      "index.md": "# Guide",
    });
    expect((await compileManifest({ dir })).resources.map((resource) => resource.type)).toEqual([
      "Guide",
    ]);
  });

  test("overlapping directories are permitted without duplicate resources", async () => {
    const dir = await fixture({
      ".topik.yaml": sources([
        { kind: "wiki", config: "wiki.yaml" },
        { kind: "wiki", config: "nested/wiki.yaml" },
      ]),
      "wiki.yaml": "id: root\ntitle: Root",
      "nested/wiki.yaml": "id: child\ntitle: Child",
    });
    expect((await compile({ dir })).resources).toHaveLength(2);
  });

  test.each([
    "version: 2\nsources: []",
    "version: '1'\nsources: []",
    "version: 1\nsources: []\nextra: true",
    "version: 1\nversion: 1\nsources: []",
    "version: 1",
    "version: 1\nsources: [!executable {}]",
    "version: 1\nsources: &a [*a]",
    "version: 1\nsources: [{kind: course, config: course.yaml}]",
    "version: 1\nsources: [{kind: wiki, config: wiki.yaml, extra: true}]",
    "[".repeat(1000),
  ])("invalid manifest never falls back (%s)", async (manifest) => {
    const dir = await fixture({
      ".topik.yaml": manifest,
      "wiki.yaml": "id: fallback\ntitle: Fallback",
    });
    await expect(compile({ dir })).rejects.toMatchObject({ id: "manifest-invalid" });
  });

  test.each([
    "/wiki.yaml",
    "../wiki.yaml",
    "docs/../wiki.yaml",
    "https://example.org/wiki.yaml",
    "docs\\wiki.yaml",
    "docs//wiki.yaml",
    "e\u0301/wiki.yaml",
    "config.txt",
  ])("rejects nonportable configuration path %s", (config) => {
    expect(() => parseTopikManifest({ version: 1, sources: [{ kind: "wiki", config }] })).toThrow();
  });

  test.each([
    ["docs/wiki.yaml", "docs/wiki.yaml"],
    ["Docs/a.yaml", "docs/b.yaml"],
    ["K/wiki.yaml", "K/wiki.yaml"],
    ["a.yaml", "a.yaml/b.yaml"],
  ])("rejects duplicate/aliased declarations %j", (...configs) => {
    expect(() =>
      parseTopikManifest({
        version: 1,
        sources: configs.map((config, index) => ({ kind: index ? "collection" : "wiki", config })),
      }),
    ).toThrow();
  });

  test.each([undefined, "title: no-id", "id: docs\nid: other\ntitle: Docs"])(
    "broken selected config has contextual error and no fallback: %s",
    async (config) => {
      const dir = await fixture({
        ".topik.yaml": sources([{ kind: "wiki", config: "docs/custom.yaml" }]),
        "docs/wiki.yaml": "id: fallback\ntitle: Fallback",
        ...(config === undefined ? {} : { "docs/custom.yaml": config }),
      });
      await expect(compile({ dir })).rejects.toMatchObject({
        sourceIndex: 0,
        kind: "wiki",
        location: "docs/custom.yaml",
      });
    },
  );

  test("rejects duplicate authored resource keys before evidence maps are merged", async () => {
    const dir = await fixture({
      ".topik.yaml": sources([
        { kind: "wiki", config: "a.yaml" },
        { kind: "wiki", config: "b.yaml" },
      ]),
      "a.yaml": wiki("same"),
      "b.yaml": wiki("same"),
      "index.md": "# Same",
    });
    await expect(compile({ dir })).rejects.toMatchObject({
      id: "manifest-resource-conflict",
      sourceIndex: 1,
      location: "b.yaml",
    });
  });

  test.each(["symlink", "hardlink", "executable", "directory", "oversized"])(
    "rejects disallowed config input: %s",
    async (kind) => {
      const dir = await fixture({
        ".topik.yaml": sources([{ kind: "wiki", config: "selected.yaml" }]),
        "target.yaml": "id: docs\ntitle: Docs",
      });
      const path = join(dir, "selected.yaml");
      if (kind === "symlink") await symlink("target.yaml", path);
      if (kind === "hardlink") await link(join(dir, "target.yaml"), path);
      if (kind === "directory") await mkdir(path);
      if (kind === "executable") {
        await writeFile(path, "id: docs\ntitle: Docs");
        await chmod(path, 0o755);
      }
      if (kind === "oversized") await writeFile(path, "#".repeat(1_048_577));
      await expect(compile({ dir })).rejects.toMatchObject({
        id: "config-read-failed",
        location: "selected.yaml",
        sourceIndex: 0,
      });
    },
  );

  test("dangling root symlink fails instead of conventional fallback", async () => {
    const dir = await fixture({ "wiki.yaml": "id: docs\ntitle: Docs" });
    await symlink("missing.yaml", join(dir, ".topik.yaml"));
    await expect(compile({ dir })).rejects.toThrow();
  });

  test("aggregate rejects conflicting output bytes and same asset identity from different evidence", async () => {
    const dir = await fixture({
      "wiki.yaml": wiki("docs"),
      "index.md": "![logo](logo.png)",
      "logo.png": PNG,
    });
    const result = await compileWiki({ dir, assets });
    const onlyAssets = {
      ...result,
      resources: result.resources.filter((resource) => resource.type === "Asset"),
      semantic: { ...result.semantic, references: [] },
    };
    expect(() =>
      mergeManifestCompilations([
        { directory: "a", result: onlyAssets },
        { directory: "b", result: onlyAssets },
      ]),
    ).toThrow();
    const changed = {
      ...onlyAssets,
      payloads: onlyAssets.payloads.map((payload) => ({
        ...payload,
        bytes: Buffer.from("different"),
      })),
    };
    expect(() =>
      mergeManifestCompilations([
        { directory: "a", result: onlyAssets },
        { directory: "a", result: changed },
      ]),
    ).toThrow();
  });
});

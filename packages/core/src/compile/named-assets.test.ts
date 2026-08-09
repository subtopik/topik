import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { Asset, Course, CourseModule, CoursePage, Guide, Wiki, WikiPage } from "@topik/schema";
import { AssetCompilationError, compileAssetResources, loadAssetDescriptors } from "./assets";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function guide(name: string, content: string): Guide {
  return {
    apiVersion: "v1",
    type: "Guide",
    name,
    spec: { title: name, slug: name, content: { format: "topik", value: content } },
  };
}

function wikiPage(name: string, content: string): WikiPage {
  return {
    apiVersion: "v1",
    type: "WikiPage",
    name,
    spec: { wiki: "docs", title: name, content: { format: "topik", value: content } },
  };
}

function localAsset(name: string, uri: string): Asset {
  return { apiVersion: "v1", type: "Asset", name, spec: { uri } };
}

describe("compilation-wide named Assets", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-named-assets-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("keeps explicit identity across byte, path, and path-plus-byte replacement", async () => {
    await mkdir(join(dir, "images"));
    await writeFile(join(dir, "images", "logo.png"), PNG_BYTES);
    const first = await compileAssetResources({
      rootDir: dir,
      resources: [localAsset("company-logo", "images/logo.png")],
      sourcePathsByResource: {},
    });
    const changed = Uint8Array.from(PNG_BYTES);
    changed[changed.length - 1] ^= 1;
    await writeFile(join(dir, "images", "logo.png"), changed);
    const replacement = await compileAssetResources({
      rootDir: dir,
      resources: [localAsset("company-logo", "images/logo.png")],
      sourcePathsByResource: {},
    });
    await writeFile(join(dir, "images", "moved.png"), changed);
    const moved = await compileAssetResources({
      rootDir: dir,
      resources: [localAsset("company-logo", "images/moved.png")],
      sourcePathsByResource: {},
    });
    expect(first.resources[0].name).toBe("company-logo");
    expect(replacement.resources[0].name).toBe("company-logo");
    expect(moved.resources[0].name).toBe("company-logo");
    expect(replacement.payloads[0].integrity).not.toBe(first.payloads[0].integrity);
    expect(moved.payloads[0].integrity).toBe(replacement.payloads[0].integrity);
  });

  test("keeps implicit identity on byte edit and treats a path move as delete/create", async () => {
    await writeFile(join(dir, "one.png"), PNG_BYTES);
    await writeFile(join(dir, "one.md"), "![One](one.png)\n");
    const input = {
      rootDir: dir,
      resources: [guide("one", "![One](one.png)\n")],
      sourcePathsByResource: { "Guide/one": "one.md" },
      sourceNamespace: "identity-fixture",
    } as const;
    const first = await compileAssetResources(input);
    const changed = Uint8Array.from(PNG_BYTES);
    changed[changed.length - 1] ^= 1;
    await writeFile(join(dir, "one.png"), changed);
    const replacement = await compileAssetResources(input);
    await writeFile(join(dir, "moved.png"), changed);
    const moved = await compileAssetResources({
      ...input,
      resources: [guide("one", "![One](moved.png)\n")],
    });
    const name = first.resources.find((resource) => resource.type === "Asset")?.name;
    expect(replacement.resources.find((resource) => resource.type === "Asset")?.name).toBe(name);
    expect(replacement.payloads[0].integrity).not.toBe(first.payloads[0].integrity);
    expect(moved.resources.find((resource) => resource.type === "Asset")?.name).not.toBe(name);
  });

  test("resolves canonical percent-encoded UTF-8 references to NFC storage paths", async () => {
    await writeFile(join(dir, "café.png"), PNG_BYTES);
    await writeFile(join(dir, "one.md"), "source\n");
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [guide("one", "![Café](caf%C3%A9.png)\n")],
      sourcePathsByResource: { "Guide/one": "one.md" },
      sourceNamespace: "unicode-fixture",
    });
    const asset = result.resources.find((resource) => resource.type === "Asset");

    expect(asset?.name).toMatch(/^auto-v1-[a-z2-7]{52}$/u);
    expect(result.payloads).toHaveLength(1);
  });

  test("rejects a source destination proved only by an unrelated Markdoc attribute", async () => {
    await writeFile(join(dir, "café.png"), PNG_BYTES);
    await writeFile(join(dir, "one.md"), "source\n");
    const content =
      '![x][id] {% callout title="![x](%C3%A9.png)" %}foo{% /callout %}\n\n> [id]: é.png';
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("one", content)],
        sourcePathsByResource: { "Guide/one": "one.md" },
        sourceNamespace: "exact-source-fixture",
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED" }),
      ]),
    });
  });

  test("isolates equal bytes by path and namespace while deduplicating physical payloads", async () => {
    await writeFile(join(dir, "a.png"), PNG_BYTES);
    await writeFile(join(dir, "b.png"), PNG_BYTES);
    await writeFile(join(dir, "one.md"), "![A](a.png) ![B](b.png)\n");
    const resources = [guide("one", "![A](a.png) ![B](b.png)\n")];
    const first = await compileAssetResources({
      rootDir: dir,
      resources,
      sourcePathsByResource: { "Guide/one": "one.md" },
      sourceNamespace: "source-one",
    });
    const second = await compileAssetResources({
      rootDir: dir,
      resources,
      sourcePathsByResource: { "Guide/one": "one.md" },
      sourceNamespace: "source-two",
    });
    const firstNames = first.resources
      .filter((resource) => resource.type === "Asset")
      .map((asset) => asset.name);
    const secondNames = second.resources
      .filter((resource) => resource.type === "Asset")
      .map((asset) => asset.name);
    expect(new Set(firstNames).size).toBe(2);
    expect(first.payloads).toHaveLength(1);
    expect(first.payloads[0].assetNames).toHaveLength(2);
    expect(secondNames).not.toEqual(firstNames);
  });

  test("shares implicit and explicit Assets across resource kinds and repeated occurrences", async () => {
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    await writeFile(join(dir, "guide.md"), "![Shared](shared.png) ![Again](shared.png)\n");
    await writeFile(join(dir, "page.md"), "![Named](asset:company-logo)\n");
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [
        guide("guide", "![Shared](shared.png) ![Again](shared.png)\n"),
        wikiPage("page", "![Named](asset:company-logo)\n"),
        localAsset("company-logo", "shared.png"),
      ],
      sourcePathsByResource: { "Guide/guide": "guide.md", "WikiPage/page": "page.md" },
      sourceNamespace: "shared-fixture",
    });
    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(2);
    expect(result.payloads).toHaveLength(1);
    expect(result.semantic.references).toHaveLength(3);
    expect(result.payloads[0].assetNames).toContain("company-logo");
  });

  test("resolves once across mixed content and container resource kinds", async () => {
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    await writeFile(join(dir, "guide.md"), "source\n");
    await writeFile(join(dir, "wiki.md"), "source\n");
    await writeFile(join(dir, "course.md"), "source\n");
    const named = "![Shared](asset:shared-media)\n";
    const wiki: Wiki = {
      apiVersion: "v1",
      type: "Wiki",
      name: "docs",
      spec: { title: "Docs" },
    };
    const course: Course = {
      apiVersion: "v1",
      type: "Course",
      name: "course",
      spec: { title: "Course", slug: "course" },
    };
    const module: CourseModule = {
      apiVersion: "v1",
      type: "CourseModule",
      name: "module",
      spec: { course: "course", title: "Module", slug: "module", order: 0 },
    };
    const page: CoursePage = {
      apiVersion: "v1",
      type: "CoursePage",
      name: "course-page",
      spec: {
        module: "module",
        title: "Page",
        slug: "page",
        order: 0,
        content: { format: "topik", value: named },
      },
    };
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [
        guide("guide", named),
        wiki,
        wikiPage("wiki-page", named),
        course,
        module,
        page,
        localAsset("shared-media", "shared.png"),
      ],
      sourcePathsByResource: {
        "Guide/guide": "guide.md",
        "WikiPage/wiki-page": "wiki.md",
        "CoursePage/course-page": "course.md",
      },
    });

    expect(result.resources.map((resource) => resource.type)).toEqual([
      "Asset",
      "Course",
      "CourseModule",
      "CoursePage",
      "Guide",
      "Wiki",
      "WikiPage",
    ]);
    expect(result.semantic.references).toHaveLength(3);
    expect(result.payloads).toHaveLength(1);
  });

  test("proves repeated plain downloads while leaving resource navigation unchanged", async () => {
    await writeFile(join(dir, "manual.bin"), "manual bytes\n");
    await writeFile(join(dir, "one.md"), "source\n");
    await writeFile(join(dir, "two.md"), "source\n");
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [
        guide("one", "[First](manual.bin) [Second](manual.bin) [Next](two.md)\n"),
        guide("two", "No assets\n"),
      ],
      sourcePathsByResource: { "Guide/one": "one.md", "Guide/two": "two.md" },
      sourceNamespace: "download-fixture",
    });
    const compiledGuide = result.resources.find(
      (resource): resource is Guide => resource.type === "Guide" && resource.name === "one",
    );

    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(1);
    expect(result.semantic.references).toHaveLength(2);
    expect(compiledGuide?.spec.content.value.match(/asset:auto-v1-/gu)).toHaveLength(2);
    expect(compiledGuide?.spec.content.value).toContain("[Next](two.md)");
  });

  test("keeps standalone and immutable remote Assets without fetching the remote", async () => {
    await writeFile(join(dir, "manual.pdf"), "%PDF-1.7\n");
    const remote: Asset = {
      apiVersion: "v1",
      type: "Asset",
      name: "remote-manual",
      spec: {
        uri: "https://cdn.example.com/revisions/manual-7.pdf",
        integrity: `sha256:${"0".repeat(64)}`,
        size: 42,
        mediaType: "application/pdf",
      },
    };
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [localAsset("local-manual", "manual.pdf"), remote],
      sourcePathsByResource: {},
    });
    expect(result.resources.filter((resource) => resource.type === "Asset")).toHaveLength(2);
    expect(result.payloads).toHaveLength(1);
    expect(result.resources.find((resource) => resource.name === "remote-manual")).toEqual(remote);
  });

  test("does not inspect non-Topik content strings", async () => {
    await writeFile(join(dir, "other.md"), "source\n");
    const other = guide("other", "arbitrary asset:missing string");
    other.spec.content.format = "other";
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [other],
      sourcePathsByResource: { "Guide/other": "other.md" },
    });

    expect(result.resources).toEqual([other]);
    expect(result.semantic.references).toEqual([]);
  });

  test("discovers strict JSON and YAML descriptors in canonical path order", async () => {
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "logo.png"), PNG_BYTES);
    await writeFile(
      join(dir, "assets", "b.yaml"),
      "apiVersion: v1\ntype: Asset\nname: second\nspec:\n  uri: logo.png\n",
    );
    await writeFile(
      join(dir, "assets", "a.json"),
      '{ "apiVersion": "v1", "type": "Asset", "name": "first", "spec": { "uri": "logo.png" } }',
    );
    expect((await loadAssetDescriptors(dir)).map((entry) => entry.path)).toEqual([
      "assets/a.json",
      "assets/b.yaml",
    ]);
    const result = await compileAssetResources({
      rootDir: dir,
      resources: [],
      sourcePathsByResource: {},
    });
    expect(result.resources.map((resource) => resource.name)).toEqual(["first", "second"]);
    expect(result.payloads).toHaveLength(1);
  });

  test("fails visibly on missing namespaces, declarations, bytes, duplicates, and forced collisions", async () => {
    await writeFile(join(dir, "a.png"), PNG_BYTES);
    await writeFile(join(dir, "b.png"), PNG_BYTES);
    await writeFile(join(dir, "one.md"), "![A](a.png) ![B](b.png)\n");
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("one", "![A](a.png)\n")],
        sourcePathsByResource: { "Guide/one": "one.md" },
      }),
    ).rejects.toMatchObject({ diagnostics: [{ id: "TOPIK_ASSET_SOURCE_NAMESPACE_REQUIRED" }] });
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("one", "![Missing](asset:missing)\n")],
        sourcePathsByResource: { "Guide/one": "one.md" },
      }),
    ).rejects.toMatchObject({ diagnostics: [{ id: "TOPIK_ASSET_REFERENCE_MISSING" }] });
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [localAsset("missing", "missing.bin")],
        sourcePathsByResource: {},
      }),
    ).rejects.toMatchObject({ diagnostics: [{ id: "TOPIK_ASSET_FILE_MISSING" }] });
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [localAsset("same", "a.png"), localAsset("same", "b.png")],
        sourcePathsByResource: {},
      }),
    ).rejects.toBeInstanceOf(AssetCompilationError);
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("one", "No assets\n"), localAsset("named", "one.md")],
        sourcePathsByResource: { "Guide/one": "one.md" },
      }),
    ).rejects.toMatchObject({ diagnostics: [{ id: "TOPIK_ASSET_REFERENCE_AMBIGUOUS" }] });
    await expect(
      compileAssetResources({
        rootDir: dir,
        resources: [guide("one", "![A](a.png) ![B](b.png)\n")],
        sourcePathsByResource: { "Guide/one": "one.md" },
        sourceNamespace: "forced-collision",
        generatedNameHash: () => new Uint8Array(32),
      }),
    ).rejects.toMatchObject({ diagnostics: [{ id: "TOPIK_ASSET_NAME_COLLISION" }] });
  });
});

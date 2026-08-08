import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { extractTopikAssetOccurrences } from "@topik/content-schema";
import type { Course, CourseModule, CoursePage, Guide, Wiki, WikiPage } from "@topik/schema";
import {
  createTopikMaterializationRecord,
  digestTopikMaterializationRecord,
  parseAssetManifest,
  serializeTopikJson,
  validateResources,
  type TopikMaterializationFileInput,
} from "../index";
import { compileGuides } from "./guide";
import {
  compilePortableResourceArtifacts,
  PortableAssetCompilationError,
  TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
} from "./assets";
import { compileWiki } from "./wiki";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function entropy() {
  let counter = 0;
  return (size: number) => {
    const bytes = new Uint8Array(size);
    bytes[bytes.length - 1] = counter++;
    return bytes;
  };
}

describe("direct portable artifact compilation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-portable-compile-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("compiles multiple guides with zero, duplicate, multiple, and shared assets", async () => {
    await writeFile(join(dir, "collection.yaml"), "id: docs\ntitle: Docs\n");
    await writeFile(join(dir, "empty.md"), "# Empty\n");
    await writeFile(join(dir, "one.md"), "# One\n\n![Shared](./shared.png)\n");
    await writeFile(
      join(dir, "many.md"),
      "# Many\n\n![First](./shared.png)\n\n![Again](./shared.png)\n\n![Other](./other.png)\n",
    );
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    const other = Uint8Array.from(PNG_BYTES);
    other[other.length - 1] ^= 1;
    await writeFile(join(dir, "other.png"), other);

    const first = await compileGuides({ dir, assets: { randomBytes: entropy() } });
    expect(first.resources).toHaveLength(3);
    expect(first.artifacts.map((artifact) => artifact.resourceRoot)).toEqual([
      "Guide/docs-empty",
      "Guide/docs-many",
      "Guide/docs-one",
    ]);
    expect(first.artifacts.map((artifact) => Object.keys(artifact.manifest.assets).length)).toEqual(
      [0, 2, 1],
    );
    const many = first.artifacts[1];
    expect(many.snapshot.occurrences).toHaveLength(3);
    expect(new Set(many.snapshot.occurrences.map((occurrence) => occurrence.assetKey)).size).toBe(
      2,
    );

    const sharedEntries = first.artifacts
      .flatMap((artifact) => Object.entries(artifact.manifest.assets))
      .filter(([, entry]) => entry.path === "shared.png");
    expect(sharedEntries).toHaveLength(2);
    expect(new Set(sharedEntries.map(([key]) => key)).size).toBe(2);
    expect(first.resources.every((resource) => !("assets" in resource.spec))).toBe(true);

    const retry = await compileGuides({
      dir,
      assets: { keyState: first.assetKeyState, randomBytes: entropy() },
    });
    expect(retry.artifacts.map((artifact) => artifact.manifestBytes)).toEqual(
      first.artifacts.map((artifact) => artifact.manifestBytes),
    );
  });

  test("compiles a multi-page wiki without giving the Wiki container an artifact", async () => {
    await writeFile(
      join(dir, "wiki.yaml"),
      "id: docs\ntitle: Docs\nnavigation:\n  - empty\n  - one\n  - many\n",
    );
    await writeFile(join(dir, "empty.md"), "# Empty\n");
    await writeFile(join(dir, "one.md"), "# One\n\n![Shared](./shared.png)\n");
    await writeFile(
      join(dir, "many.md"),
      "# Many\n\n![Shared](./shared.png)\n\n![A](./a.png)\n\n![B](./b.png)\n",
    );
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    await writeFile(join(dir, "a.png"), PNG_BYTES);
    await writeFile(join(dir, "b.png"), PNG_BYTES);

    const result = await compileWiki({ dir, assets: { randomBytes: entropy() } });
    expect(result.resources.map((resource) => resource.type)).toEqual([
      "WikiPage",
      "WikiPage",
      "WikiPage",
      "Wiki",
    ]);
    expect(validateResources(result.resources)).toMatchObject({ valid: true });
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts.map((artifact) => artifact.resourceRoot)).not.toContain("Wiki/docs");
    const counts = new Map(
      result.artifacts.map((artifact) => [
        artifact.resource.spec.title,
        Object.keys(artifact.manifest.assets).length,
      ]),
    );
    expect(counts).toEqual(
      new Map<string, number>([
        ["Empty", 0],
        ["Many", 3],
        ["One", 1],
      ]),
    );
    const shared = result.artifacts.flatMap((artifact) =>
      Object.entries(artifact.manifest.assets).filter(([, entry]) => entry.path === "shared.png"),
    );
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map(([key]) => key)).size).toBe(2);
  });

  test("compiles generic downloads only from explicit schema/application positions", async () => {
    const content = "[Download](manual.bin)\n";
    const [declared] = extractTopikAssetOccurrences(content, { manifestPaths: ["manual.bin"] });
    await writeFile(join(dir, "guide.md"), content);
    await writeFile(join(dir, "manual.bin"), "offline bytes");
    const resource = guideResource("download", content);

    const undeclared = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [resource],
      sourcePathsByResource: { "Guide/download": "guide.md" },
      randomBytes: entropy(),
    });
    expect(undeclared.artifacts[0].manifest.assets).toEqual({});

    const declaredDownload = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [resource],
      sourcePathsByResource: { "Guide/download": "guide.md" },
      downloadableLinkPositionsByResource: {
        "Guide/download": [declared.position],
      },
      randomBytes: entropy(),
    });
    expect(Object.values(declaredDownload.artifacts[0].manifest.assets)).toMatchObject([
      { path: "manual.bin", mediaType: "application/octet-stream" },
    ]);
  });

  test("compiles a mixed resource set and assigns artifacts only to content-bearing resources", async () => {
    await mkdir(join(dir, "pages"));
    await writeFile(join(dir, "guide.md"), "![Guide](shared.png)\n");
    await writeFile(join(dir, "pages", "first.md"), "![First](../shared.png)\n");
    await writeFile(join(dir, "pages", "second.md"), "# Second\n");
    await writeFile(join(dir, "course.md"), "![Course](course.png)\n");
    await writeFile(join(dir, "shared.png"), PNG_BYTES);
    await writeFile(join(dir, "course.png"), PNG_BYTES);

    const guide = guideResource("guide", "![Guide](shared.png)\n");
    const wiki: Wiki = { apiVersion: "v1", type: "Wiki", name: "wiki", spec: { title: "Wiki" } };
    const first = wikiPageResource("first", "![First](../shared.png)\n");
    const second = wikiPageResource("second", "# Second\n");
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
        title: "Course page",
        slug: "page",
        order: 0,
        content: { format: "topik", value: "![Course](course.png)\n" },
      },
    };
    const resources = [guide, wiki, first, second, course, module, page];
    const compiled = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources,
      sourcePathsByResource: {
        "Guide/guide": "guide.md",
        "WikiPage/first": "pages/first.md",
        "WikiPage/second": "pages/second.md",
        "CoursePage/course-page": "course.md",
      },
      randomBytes: entropy(),
    });

    expect(validateResources(compiled.resources)).toMatchObject({ valid: true });
    expect(compiled.artifacts.map((artifact) => artifact.resourceRoot)).toEqual([
      "CoursePage/course-page",
      "Guide/guide",
      "WikiPage/first",
      "WikiPage/second",
    ]);
    expect(compiled.resources.map((resource) => resource.type)).toEqual(
      resources.map((resource) => resource.type),
    );
    expect(compiled.artifacts.map((artifact) => artifact.resource.type)).not.toContain("Wiki");
    expect(compiled.artifacts.map((artifact) => artifact.resource.type)).not.toContain("Course");
    expect(compiled.artifacts.map((artifact) => artifact.resource.type)).not.toContain(
      "CourseModule",
    );
  });

  test("fails closed for missing, unsafe, executable, colliding, and ambiguous inputs", async () => {
    const missing = guideResource("missing", "![Missing](missing.png)\n");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [missing],
        sourcePathsByResource: { "Guide/missing": "missing.md" },
        randomBytes: entropy(),
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_FILE_MISSING" }),
      ]),
    });

    const unsafe = guideResource("unsafe", "![Unsafe](http://example.com/a.png)\n");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [unsafe],
        sourcePathsByResource: { "Guide/unsafe": "unsafe.md" },
      }),
    ).rejects.toBeInstanceOf(PortableAssetCompilationError);

    await writeFile(join(dir, "executable.png"), PNG_BYTES);
    await chmod(join(dir, "executable.png"), 0o755);
    const executable = guideResource("executable", "![Executable](executable.png)\n");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [executable],
        sourcePathsByResource: { "Guide/executable": "executable.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_FILE_TYPE_UNSUPPORTED" }),
      ]),
    });

    await writeFile(join(dir, "real.png"), PNG_BYTES);
    await symlink("real.png", join(dir, "linked.png"));
    const linked = guideResource("linked", "![Linked](linked.png)\n");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [linked],
        sourcePathsByResource: { "Guide/linked": "linked.md" },
      }),
    ).rejects.toBeInstanceOf(PortableAssetCompilationError);

    const collision = guideResource("collision", "![One](Straße.png)\n\n![Two](STRASSE.png)\n");
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [collision],
        sourcePathsByResource: { "Guide/collision": "collision.md" },
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_COLLISION" }),
      ]),
    });

    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [guideResource("same", "# One\n"), guideResource("same", "# Two\n")],
        sourcePathsByResource: { "Guide/same": "same.md" },
      }),
    ).rejects.toThrow(/repeats a resource identity/u);
  });

  test("proves exact inventory completeness, binding, modes, determinism, and byte identity", async () => {
    await writeFile(join(dir, "guide.md"), "![Hero](hero.png)\n");
    await writeFile(join(dir, "hero.png"), PNG_BYTES);
    const compiled = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("exact", "![Hero](hero.png)\n")],
      sourcePathsByResource: { "Guide/exact": "guide.md" },
      randomBytes: entropy(),
    });
    const artifact = compiled.artifacts[0];
    const descriptors = artifact.materialization.descriptors;
    const exact = (inventory: readonly TopikMaterializationFileInput[]) =>
      createTopikMaterializationRecord(descriptors, inventory, { contentPath: "content.topik" });

    for (const missing of ["hero.png", "resource.json", "content.topik", ".topik/assets.json"]) {
      expect(() => exact(artifact.inventory.filter((file) => file.path !== missing))).toThrow(
        /missing|complete/u,
      );
    }
    expect(() =>
      exact([
        ...artifact.inventory,
        { path: "extra.bin", type: "regular", mode: "100644", bytes: new Uint8Array([1]) },
      ]),
    ).toThrow(/complete/u);
    const resourceIndex = artifact.inventory.findIndex((file) => file.path === "resource.json");
    const wrongBinding = artifact.inventory.map((file, index) =>
      index === resourceIndex
        ? {
            ...file,
            bytes: new TextEncoder().encode(
              serializeTopikJson({ ...artifact.resource, name: "different" }),
            ),
          }
        : file,
    );
    expect(() => exact(wrongBinding)).toThrow(/binding/u);
    expect(() =>
      exact(
        artifact.inventory.map((file) =>
          file.path === "content.topik"
            ? { ...file, bytes: new TextEncoder().encode("changed") }
            : file,
        ),
      ),
    ).toThrow(/content/u);
    expect(() =>
      exact(
        artifact.inventory.map((file) =>
          file.path === "hero.png" ? { ...file, mode: "100755" as never } : file,
        ),
      ),
    ).toThrow(/mode/u);
    expect(() =>
      exact(
        artifact.inventory.map((file) =>
          file.path === "hero.png" ? { ...file, type: "symlink" as never } : file,
        ),
      ),
    ).toThrow(/type/u);

    const reversed = exact([...artifact.inventory].reverse());
    expect(digestTopikMaterializationRecord(reversed)).toBe(
      digestTopikMaterializationRecord(artifact.materialization),
    );
    const modeChanged = exact(
      artifact.inventory.map((file) => ({ ...file, mode: "0644" as const })),
    );
    expect(digestTopikMaterializationRecord(modeChanged)).not.toBe(
      digestTopikMaterializationRecord(artifact.materialization),
    );

    const changedContent = "# Changed\n";
    const changedResource = {
      ...artifact.resource,
      spec: {
        ...artifact.resource.spec,
        content: { ...artifact.resource.spec.content, value: changedContent },
      },
    };
    const contentChanged = exact(
      artifact.inventory.map((file) => {
        if (file.path === "resource.json") {
          return {
            ...file,
            bytes: new TextEncoder().encode(serializeTopikJson(changedResource)),
          };
        }
        return file.path === "content.topik"
          ? { ...file, bytes: new TextEncoder().encode(changedContent) }
          : file;
      }),
    );
    expect(digestTopikMaterializationRecord(contentChanged)).not.toBe(
      digestTopikMaterializationRecord(artifact.materialization),
    );

    const changedAssetBytes = Uint8Array.from(PNG_BYTES);
    changedAssetBytes[changedAssetBytes.length - 1] ^= 1;
    await writeFile(join(dir, "hero.png"), changedAssetBytes);
    const changedAsset = await compilePortableResourceArtifacts({
      rootDir: dir,
      resources: [guideResource("exact", "![Hero](hero.png)\n")],
      sourcePathsByResource: { "Guide/exact": "guide.md" },
      keyState: compiled.keyState,
      randomBytes: entropy(),
    });
    expect(digestTopikMaterializationRecord(changedAsset.artifacts[0].materialization)).not.toBe(
      digestTopikMaterializationRecord(artifact.materialization),
    );

    const parsed = parseAssetManifest(artifact.manifestBytes);
    expect(parsed).toMatchObject({ ok: true });
    const sidecar = artifact.inventory.find((file) => file.path === ".topik/assets.json");
    expect(sidecar?.bytes).toEqual(artifact.manifestBytes);
  });

  test("rejects duplicate persisted keys across resource ownership scopes", async () => {
    const key = "ast_00000000000000000000000000";
    await expect(
      compilePortableResourceArtifacts({
        rootDir: dir,
        resources: [],
        sourcePathsByResource: {},
        keyState: {
          version: TOPIK_PORTABLE_ASSET_KEY_STATE_VERSION,
          keysByResource: { A: { "a.png": key }, B: { "b.png": key } },
          retiredKeys: [],
        },
      }),
    ).rejects.toThrow(/invalid or ambiguous/u);
  });
});

function guideResource(name: string, content: string): Guide {
  return {
    apiVersion: "v1",
    type: "Guide",
    name,
    spec: { title: name, slug: name, content: { format: "topik", value: content } },
  };
}

function wikiPageResource(name: string, content: string): WikiPage {
  return {
    apiVersion: "v1",
    type: "WikiPage",
    name,
    spec: { wiki: "wiki", title: name, content: { format: "topik", value: content } },
  };
}
